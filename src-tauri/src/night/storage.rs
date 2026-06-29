//! The assistant database (`<vault>/.onyx/assistant.db`): activity events,
//! deferred jobs, suggestions, processing runs, and dismissals.

use rusqlite::Connection;

/// Suggestions/events older than this are pruned.
const RETAIN_DAYS: i64 = 30;

pub fn init_db(conn: &Connection) -> rusqlite::Result<()> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS events(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           timestamp INTEGER NOT NULL,
           type TEXT NOT NULL,
           entity TEXT,
           metadata TEXT
         );
         CREATE TABLE IF NOT EXISTS jobs(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           type TEXT NOT NULL,
           priority INTEGER NOT NULL DEFAULT 0,
           created_at INTEGER NOT NULL,
           status TEXT NOT NULL DEFAULT 'PENDING',
           payload TEXT
         );
         CREATE TABLE IF NOT EXISTS suggestions(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           type TEXT NOT NULL,
           confidence REAL NOT NULL,
           title TEXT NOT NULL,
           preview TEXT,
           body TEXT,
           target_path TEXT,
           signature TEXT,
           created_at INTEGER NOT NULL,
           status TEXT NOT NULL DEFAULT 'pending'
         );
         CREATE TABLE IF NOT EXISTS processing_runs(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           started_at INTEGER NOT NULL,
           finished_at INTEGER,
           notes_processed INTEGER NOT NULL DEFAULT 0,
           links_found INTEGER NOT NULL DEFAULT 0,
           summaries_created INTEGER NOT NULL DEFAULT 0,
           status TEXT NOT NULL DEFAULT 'running'
         );
         CREATE TABLE IF NOT EXISTS dismissals(
           id INTEGER PRIMARY KEY AUTOINCREMENT,
           signature TEXT NOT NULL,
           created_at INTEGER NOT NULL
         );",
    )
}

/// Drop events and finished suggestions older than the retention window.
pub fn prune(conn: &Connection, now: i64) -> rusqlite::Result<()> {
    let cutoff = now - RETAIN_DAYS * 86_400;
    conn.execute("DELETE FROM events WHERE timestamp < ?1", [cutoff])?;
    conn.execute(
        "DELETE FROM suggestions WHERE created_at < ?1 AND status != 'pending'",
        [cutoff],
    )?;
    conn.execute("DELETE FROM suggestions WHERE created_at < ?1", [cutoff])?;
    Ok(())
}
