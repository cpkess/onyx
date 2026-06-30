//! Turns recent activity into deferred jobs, de-duplicated against pending work.

use rusqlite::{params, Connection};
use std::collections::HashMap;

use super::events;

/// A unit of deferred work. `payload` carries the target (a note path, or
/// `tag:<name>` for synthesis).
#[derive(Debug, Clone)]
pub struct Job {
    pub id: i64,
    pub kind: String,
    pub payload: String,
}

const SUMMARIZE_EDIT_THRESHOLD: i64 = 3;
const SYNTHESIZE_TAG_THRESHOLD: usize = 3;

/// Inspect events since the last run and enqueue jobs. Returns the number added.
pub fn plan_jobs(
    vault_conn: &Connection,
    night_conn: &Connection,
    since: i64,
    now: i64,
) -> rusqlite::Result<usize> {
    let touched = events::touched_notes_since(night_conn, since)?;
    let mut added = 0usize;
    let mut tag_counts: HashMap<String, usize> = HashMap::new();

    for (path, edits) in &touched {
        added += enqueue(night_conn, "INDEX", path, 1, now)?;
        added += enqueue(night_conn, "LINK_DISCOVERY", path, 2, now)?;
        added += enqueue(night_conn, "ATOMIZE", path, 5, now)?;
        if *edits >= SUMMARIZE_EDIT_THRESHOLD {
            added += enqueue(night_conn, "SUMMARIZE", path, 3, now)?;
        }
        for tag in note_tags(vault_conn, path)? {
            *tag_counts.entry(tag).or_default() += 1;
        }
    }

    for (tag, count) in tag_counts {
        if count >= SYNTHESIZE_TAG_THRESHOLD {
            added += enqueue(night_conn, "SYNTHESIZE", &format!("tag:{tag}"), 4, now)?;
        }
    }

    Ok(added)
}

/// Insert a job unless an identical PENDING one already exists.
fn enqueue(
    conn: &Connection,
    kind: &str,
    payload: &str,
    priority: i64,
    now: i64,
) -> rusqlite::Result<usize> {
    let exists: i64 = conn.query_row(
        "SELECT COUNT(*) FROM jobs WHERE type = ?1 AND payload = ?2 AND status = 'PENDING'",
        params![kind, payload],
        |r| r.get(0),
    )?;
    if exists > 0 {
        return Ok(0);
    }
    conn.execute(
        "INSERT INTO jobs(type, priority, created_at, status, payload)
         VALUES (?1, ?2, ?3, 'PENDING', ?4)",
        params![kind, priority, now, payload],
    )?;
    Ok(1)
}

fn note_tags(vault_conn: &Connection, path: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = vault_conn.prepare(
        "SELECT t.tag FROM tags t JOIN notes n ON n.id = t.note_id WHERE n.path = ?1",
    )?;
    let tags = stmt
        .query_map([path], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    Ok(tags)
}

/// All PENDING jobs ordered by priority (ascending stage order).
pub fn pending_jobs(conn: &Connection) -> rusqlite::Result<Vec<Job>> {
    let mut stmt = conn.prepare(
        "SELECT id, type, payload FROM jobs WHERE status = 'PENDING' ORDER BY priority, id",
    )?;
    let jobs = stmt
        .query_map([], |r| {
            Ok(Job {
                id: r.get(0)?,
                kind: r.get(1)?,
                payload: r.get::<_, Option<String>>(2)?.unwrap_or_default(),
            })
        })?
        .filter_map(|r| r.ok())
        .collect();
    Ok(jobs)
}

pub fn set_job_status(conn: &Connection, id: i64, status: &str) -> rusqlite::Result<()> {
    conn.execute("UPDATE jobs SET status = ?2 WHERE id = ?1", params![id, status])?;
    Ok(())
}

pub fn pending_count(conn: &Connection) -> i64 {
    conn.query_row("SELECT COUNT(*) FROM jobs WHERE status = 'PENDING'", [], |r| r.get(0))
        .unwrap_or(0)
}
