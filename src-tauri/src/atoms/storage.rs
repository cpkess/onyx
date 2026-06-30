//! The atoms database (`<vault>/.onyx/atoms.db`): extracted knowledge units,
//! their relationships, embeddings, and per-source synthesis state. Source notes
//! are never modified — everything here is regenerable.

use rusqlite::{params, Connection};
use std::collections::hash_map::DefaultHasher;
use std::hash::{Hash, Hasher};

pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS atoms(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           kind TEXT NOT NULL,
           text TEXT NOT NULL,
           source_path TEXT NOT NULL,
           source_chunk INTEGER,
           source_heading TEXT,
           confidence REAL NOT NULL DEFAULT 0.8,
           status TEXT NOT NULL DEFAULT 'pending',
           signature TEXT,
           merged_into INTEGER,
           created_at INTEGER NOT NULL,
           updated_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_atoms_status ON atoms(status);
         CREATE INDEX IF NOT EXISTS idx_atoms_source ON atoms(source_path);
         CREATE INDEX IF NOT EXISTS idx_atoms_kind ON atoms(kind);

         CREATE TABLE IF NOT EXISTS atom_relations(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           from_id INTEGER NOT NULL,
           to_id INTEGER NOT NULL,
           kind TEXT NOT NULL,
           confidence REAL,
           created_at INTEGER NOT NULL
         );
         CREATE INDEX IF NOT EXISTS idx_rel_from ON atom_relations(from_id);
         CREATE INDEX IF NOT EXISTS idx_rel_to ON atom_relations(to_id);

         CREATE TABLE IF NOT EXISTS synth_state(
           source_path TEXT PRIMARY KEY,
           content_hash TEXT NOT NULL,
           synthesized_at INTEGER NOT NULL
         );",
    )
}

/// A stable content hash for incremental synthesis (skip unchanged notes).
pub fn content_hash(content: &str) -> String {
    let mut h = DefaultHasher::new();
    content.hash(&mut h);
    format!("{:016x}", h.finish())
}

/// Normalized signature for dedup: kind + lowercased, whitespace-collapsed text.
pub fn signature(kind: &str, text: &str) -> String {
    let norm = text.split_whitespace().collect::<Vec<_>>().join(" ").to_lowercase();
    format!("{kind}|{norm}")
}

// ---- atom embeddings (vec0, keyed by atom id) ----

pub fn ensure_vec(conn: &Connection, dim: usize) -> rusqlite::Result<()> {
    conn.execute(
        &format!(
            "CREATE VIRTUAL TABLE IF NOT EXISTS atom_vec USING vec0(
                embedding float[{dim}],
                atom_id integer
            )"
        ),
        [],
    )?;
    Ok(())
}

fn vec_exists(conn: &Connection) -> bool {
    conn.query_row(
        "SELECT count(*) FROM sqlite_master WHERE type='table' AND name='atom_vec'",
        [],
        |r| r.get::<_, i64>(0),
    )
    .map(|c| c > 0)
    .unwrap_or(false)
}

fn vector_to_json(v: &[f32]) -> String {
    format!("[{}]", v.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(","))
}

pub fn upsert_atom_vec(conn: &Connection, atom_id: i64, embedding: &[f32]) -> rusqlite::Result<()> {
    ensure_vec(conn, embedding.len())?;
    conn.execute("DELETE FROM atom_vec WHERE atom_id = ?1", params![atom_id])?;
    conn.execute(
        "INSERT INTO atom_vec(embedding, atom_id) VALUES (?1, ?2)",
        params![vector_to_json(embedding), atom_id],
    )?;
    Ok(())
}

/// k-nearest atom ids to a query embedding (excluding `exclude_id`).
pub fn search_atom_vec(
    conn: &Connection,
    query: &[f32],
    k: usize,
    exclude_id: i64,
) -> rusqlite::Result<Vec<(i64, f32)>> {
    if !vec_exists(conn) {
        return Ok(vec![]);
    }
    let mut stmt = conn.prepare(
        "SELECT atom_id, distance FROM atom_vec
         WHERE embedding MATCH ?1 AND k = ?2 ORDER BY distance",
    )?;
    let rows = stmt
        .query_map(params![vector_to_json(query), (k + 1) as i64], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, f32>(1)?))
        })?
        .filter_map(|r| r.ok())
        .filter(|(id, _)| *id != exclude_id)
        .take(k)
        .collect();
    Ok(rows)
}

/// Wipe all atoms data (rebuild). Source notes are untouched.
pub fn clear_all(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "DELETE FROM atoms;
         DELETE FROM atom_relations;
         DELETE FROM synth_state;
         DROP TABLE IF EXISTS atom_vec;",
    )
}
