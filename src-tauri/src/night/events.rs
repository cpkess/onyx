//! Passive activity logging. Events are append-only and never trigger model calls.

use rusqlite::{params, Connection};

/// Append one activity event.
pub fn record(
    conn: &Connection,
    kind: &str,
    entity: Option<&str>,
    metadata: Option<&str>,
    now: i64,
) -> rusqlite::Result<()> {
    conn.execute(
        "INSERT INTO events(timestamp, type, entity, metadata) VALUES (?1, ?2, ?3, ?4)",
        params![now, kind, entity, metadata],
    )?;
    Ok(())
}

/// Distinct note entities touched by EDIT/CREATE/IMPORT events since `since`,
/// each with the number of such events (used to detect "grew a lot").
pub fn touched_notes_since(conn: &Connection, since: i64) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT entity, COUNT(*) FROM events
         WHERE timestamp > ?1
           AND entity IS NOT NULL
           AND type IN ('EDIT_NOTE','CREATE_NOTE','IMPORT_DOCUMENT')
         GROUP BY entity",
    )?;
    let rows = stmt
        .query_map([since], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .filter_map(|r| r.ok())
        .filter(|(e, _)| e.to_lowercase().ends_with(".md"))
        .collect();
    Ok(rows)
}
