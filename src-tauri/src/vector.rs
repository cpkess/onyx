//! Vector storage for semantic search, backed by the `sqlite-vec` extension.
//! Embeddings live in the same `<vault>/.onyx/onyx.db` as the rest of the index.

use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;

/// Register sqlite-vec as a SQLite auto-extension. Must be called once at
/// startup, before any database connection is opened.
pub fn register() {
    unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    }
}

#[derive(Debug, Serialize)]
pub struct SemanticHit {
    pub path: String,
    pub chunk_index: i64,
    pub text: String,
    pub distance: f32,
}

fn vector_to_json(v: &[f32]) -> String {
    let parts: Vec<String> = v.iter().map(|x| x.to_string()).collect();
    format!("[{}]", parts.join(","))
}

/// (Re)create the chunk vector table for a given embedding dimension, clearing
/// any previous embeddings. Called at the start of a full re-index.
pub fn reset_table(conn: &Connection, dim: usize) -> rusqlite::Result<()> {
    conn.execute(
        "CREATE TABLE IF NOT EXISTS vec_meta(key TEXT PRIMARY KEY, value INTEGER)",
        [],
    )?;
    conn.execute("DROP TABLE IF EXISTS vec_chunks", [])?;
    conn.execute(
        &format!(
            "CREATE VIRTUAL TABLE vec_chunks USING vec0(
                embedding float[{dim}],
                note_path text,
                chunk_index integer,
                +chunk_text text
            )"
        ),
        [],
    )?;
    conn.execute(
        "INSERT OR REPLACE INTO vec_meta(key, value) VALUES('dim', ?1)",
        params![dim as i64],
    )?;
    Ok(())
}

/// Insert a single embedded chunk.
pub fn insert_chunk(
    conn: &Connection,
    path: &str,
    chunk_index: i64,
    text: &str,
    embedding: &[f32],
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO vec_chunks(embedding, note_path, chunk_index, chunk_text)
         VALUES (?1, ?2, ?3, ?4)",
        params![vector_to_json(embedding), path, chunk_index, text],
    )?;
    Ok(())
}

/// Number of embedded chunks currently stored (0 if not yet indexed).
pub fn chunk_count(conn: &Connection) -> i64 {
    let exists: bool = conn
        .query_row(
            "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='vec_chunks'",
            [],
            |r| r.get::<_, i64>(0),
        )
        .map(|c| c > 0)
        .unwrap_or(false);
    if !exists {
        return 0;
    }
    conn.query_row("SELECT count(*) FROM vec_chunks", [], |r| r.get(0))
        .optional()
        .ok()
        .flatten()
        .unwrap_or(0)
}

/// k-nearest-neighbour search over stored chunks.
pub fn search(
    conn: &Connection,
    query_embedding: &[f32],
    k: usize,
) -> rusqlite::Result<Vec<SemanticHit>> {
    if chunk_count(conn) == 0 {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(
        "SELECT note_path, chunk_index, chunk_text, distance
         FROM vec_chunks
         WHERE embedding MATCH ?1 AND k = ?2
         ORDER BY distance",
    )?;
    let rows = stmt.query_map(
        params![vector_to_json(query_embedding), k as i64],
        |r| {
            Ok(SemanticHit {
                path: r.get(0)?,
                chunk_index: r.get(1)?,
                text: r.get(2)?,
                distance: r.get(3)?,
            })
        },
    )?;
    rows.collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Once;

    static INIT: Once = Once::new();

    #[test]
    fn vec_store_roundtrip() {
        INIT.call_once(register);
        let conn = Connection::open_in_memory().unwrap();
        reset_table(&conn, 3).unwrap();
        insert_chunk(&conn, "a.md", 0, "apple", &[1.0, 0.0, 0.0]).unwrap();
        insert_chunk(&conn, "b.md", 0, "banana", &[0.0, 1.0, 0.0]).unwrap();
        assert_eq!(chunk_count(&conn), 2);

        // Query closest to "a".
        let hits = search(&conn, &[0.9, 0.1, 0.0], 1).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].path, "a.md");
        assert_eq!(hits[0].text, "apple");
    }
}
