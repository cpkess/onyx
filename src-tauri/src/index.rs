//! Markdown indexing: note metadata, wikilinks, tags, backlinks and full-text
//! search, all stored in a single SQLite database living at `<vault>/.onyx/onyx.db`.

use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection};
use serde::Serialize;
use std::path::Path;
use walkdir::WalkDir;

static WIKILINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
// A tag is `#` immediately followed by a word char (so markdown headings like
// "# Title", which have a space after `#`, are not matched).
static TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|[^\w&])#([A-Za-z0-9_][A-Za-z0-9_/-]*)").unwrap());
static H1_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^#\s+(.+)$").unwrap());

#[derive(Debug, Serialize)]
pub struct Backlink {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct SearchResult {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

#[derive(Debug, Serialize)]
pub struct GraphNode {
    pub id: String,
    pub label: String,
}

#[derive(Debug, Serialize)]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
}

#[derive(Debug, Serialize)]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

/// Open (creating if needed) the SQLite database and ensure the schema exists.
pub fn init_db(db_path: &Path) -> rusqlite::Result<Connection> {
    if let Some(parent) = db_path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let conn = Connection::open(db_path)?;
    conn.execute_batch(
        r#"
        PRAGMA journal_mode = WAL;
        PRAGMA foreign_keys = ON;

        CREATE TABLE IF NOT EXISTS notes (
            id    INTEGER PRIMARY KEY,
            path  TEXT UNIQUE NOT NULL,
            title TEXT NOT NULL,
            mtime INTEGER NOT NULL DEFAULT 0
        );

        CREATE TABLE IF NOT EXISTS links (
            source_id INTEGER NOT NULL,
            target    TEXT NOT NULL,
            FOREIGN KEY(source_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_links_target ON links(target);

        CREATE TABLE IF NOT EXISTS tags (
            note_id INTEGER NOT NULL,
            tag     TEXT NOT NULL,
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tags_tag ON tags(tag);

        CREATE VIRTUAL TABLE IF NOT EXISTS notes_fts
            USING fts5(path UNINDEXED, title, body);
        "#,
    )?;
    Ok(conn)
}

/// The note "name" used by `[[wikilinks]]` — the file stem.
pub fn note_name(rel_path: &str) -> String {
    Path::new(rel_path)
        .file_stem()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| rel_path.to_string())
}

fn extract_title(content: &str, rel_path: &str) -> String {
    if let Some(c) = H1_RE.captures(content) {
        return c[1].trim().to_string();
    }
    note_name(rel_path)
}

/// Parse `[[Target]]` / `[[Target|alias]]` / `[[Target#heading]]` into bare target names.
pub fn extract_wikilinks(content: &str) -> Vec<String> {
    let mut out = Vec::new();
    for c in WIKILINK_RE.captures_iter(content) {
        let raw = &c[1];
        let target = raw.split('|').next().unwrap_or(raw);
        let target = target.split('#').next().unwrap_or(target).trim();
        if !target.is_empty() {
            out.push(target.to_string());
        }
    }
    out.sort();
    out.dedup();
    out
}

/// Parse `#tag` occurrences (excluding markdown headings).
pub fn extract_tags(content: &str) -> Vec<String> {
    let mut out: Vec<String> = TAG_RE
        .captures_iter(content)
        .map(|c| c[1].to_string())
        .collect();
    out.sort();
    out.dedup();
    out
}

fn first_nonempty_line(content: &str) -> String {
    content
        .lines()
        .map(|l| l.trim())
        .find(|l| !l.is_empty() && !l.starts_with('#'))
        .unwrap_or("")
        .chars()
        .take(160)
        .collect()
}

/// Index (insert or update) a single note given its content.
pub fn index_note(conn: &Connection, rel_path: &str, content: &str, mtime: i64) -> rusqlite::Result<()> {
    let title = extract_title(content, rel_path);

    conn.execute(
        "INSERT INTO notes (path, title, mtime) VALUES (?1, ?2, ?3)
         ON CONFLICT(path) DO UPDATE SET title = excluded.title, mtime = excluded.mtime",
        params![rel_path, title, mtime],
    )?;
    let note_id: i64 = conn.query_row(
        "SELECT id FROM notes WHERE path = ?1",
        params![rel_path],
        |r| r.get(0),
    )?;

    conn.execute("DELETE FROM links WHERE source_id = ?1", params![note_id])?;
    conn.execute("DELETE FROM tags WHERE note_id = ?1", params![note_id])?;
    for target in extract_wikilinks(content) {
        conn.execute(
            "INSERT INTO links (source_id, target) VALUES (?1, ?2)",
            params![note_id, target],
        )?;
    }
    for tag in extract_tags(content) {
        conn.execute(
            "INSERT INTO tags (note_id, tag) VALUES (?1, ?2)",
            params![note_id, tag],
        )?;
    }

    conn.execute("DELETE FROM notes_fts WHERE path = ?1", params![rel_path])?;
    conn.execute(
        "INSERT INTO notes_fts (path, title, body) VALUES (?1, ?2, ?3)",
        params![rel_path, title, content],
    )?;
    Ok(())
}

/// Split note content into embedding-sized chunks, grouping whole paragraphs up
/// to roughly `max_chars` each. Returns `(chunk_index, text)` pairs.
pub fn chunk_content(content: &str, max_chars: usize) -> Vec<(i64, String)> {
    let mut chunks = Vec::new();
    let mut current = String::new();

    let flush = |current: &mut String, chunks: &mut Vec<(i64, String)>| {
        let trimmed = current.trim();
        if !trimmed.is_empty() {
            chunks.push((chunks.len() as i64, trimmed.to_string()));
        }
        current.clear();
    };

    for para in content.split("\n\n") {
        let para = para.trim();
        if para.is_empty() {
            continue;
        }
        if !current.is_empty() && current.len() + para.len() + 2 > max_chars {
            flush(&mut current, &mut chunks);
        }
        if !current.is_empty() {
            current.push_str("\n\n");
        }
        current.push_str(para);
        // A single very large paragraph becomes its own chunk.
        if current.len() >= max_chars {
            flush(&mut current, &mut chunks);
        }
    }
    flush(&mut current, &mut chunks);
    chunks
}

/// Remove a note that no longer exists on disk.
pub fn remove_note(conn: &Connection, rel_path: &str) -> rusqlite::Result<()> {
    conn.execute("DELETE FROM notes WHERE path = ?1", params![rel_path])?;
    conn.execute("DELETE FROM notes_fts WHERE path = ?1", params![rel_path])?;
    Ok(())
}

/// Wipe and rebuild the index from every `.md` file under `root`.
pub fn reindex_all(conn: &mut Connection, root: &Path) -> rusqlite::Result<usize> {
    let tx = conn.transaction()?;
    tx.execute_batch(
        "DELETE FROM notes; DELETE FROM links; DELETE FROM tags; DELETE FROM notes_fts;",
    )?;
    let mut count = 0;
    for entry in WalkDir::new(root)
        .into_iter()
        .filter_map(|e| e.ok())
        .filter(|e| e.file_type().is_file())
    {
        let path = entry.path();
        if path.extension().and_then(|e| e.to_str()) != Some("md") {
            continue;
        }
        // Skip the .onyx metadata directory.
        if path.components().any(|c| c.as_os_str() == ".onyx") {
            continue;
        }
        let rel = match path.strip_prefix(root) {
            Ok(r) => r.to_string_lossy().replace('\\', "/"),
            Err(_) => continue,
        };
        let content = std::fs::read_to_string(path).unwrap_or_default();
        let mtime = entry
            .metadata()
            .ok()
            .and_then(|m| m.modified().ok())
            .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        index_note(&tx, &rel, &content, mtime)?;
        count += 1;
    }
    tx.commit()?;
    Ok(count)
}

/// Notes that link to `name` (the file stem of the target note).
pub fn backlinks(conn: &Connection, name: &str) -> rusqlite::Result<Vec<Backlink>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT n.path, n.title
         FROM links l JOIN notes n ON n.id = l.source_id
         WHERE l.target = ?1 COLLATE NOCASE
         ORDER BY n.title",
    )?;
    let rows = stmt.query_map(params![name], |r| {
        Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (path, title) = row?;
        let content = String::new(); // snippet is filled by caller-side read if needed
        let snippet = first_nonempty_line(&content);
        out.push(Backlink { path, title, snippet });
    }
    Ok(out)
}

/// Full-text search over note titles and bodies.
pub fn search(conn: &Connection, query: &str) -> rusqlite::Result<Vec<SearchResult>> {
    let q = query.trim();
    if q.is_empty() {
        return Ok(vec![]);
    }
    // Build a prefix MATCH query, escaping double-quotes.
    let match_query = q
        .split_whitespace()
        .map(|t| format!("\"{}\"*", t.replace('"', "\"\"")))
        .collect::<Vec<_>>()
        .join(" ");
    let mut stmt = conn.prepare(
        "SELECT path, title, snippet(notes_fts, 2, '<<', '>>', '…', 12) AS snip
         FROM notes_fts
         WHERE notes_fts MATCH ?1
         ORDER BY rank
         LIMIT 50",
    )?;
    let rows = stmt.query_map(params![match_query], |r| {
        Ok(SearchResult {
            path: r.get(0)?,
            title: r.get(1)?,
            snippet: r.get(2)?,
        })
    })?;
    rows.collect()
}

/// All note names (file stems) for wikilink autocomplete.
pub fn all_note_names(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM notes ORDER BY path")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut names = Vec::new();
    for r in rows {
        names.push(note_name(&r?));
    }
    names.sort();
    names.dedup();
    Ok(names)
}

/// Build the full link graph (resolving wikilink targets to existing notes).
pub fn graph(conn: &Connection) -> rusqlite::Result<GraphData> {
    let mut node_stmt = conn.prepare("SELECT path, title FROM notes")?;
    let nodes: Vec<GraphNode> = node_stmt
        .query_map([], |r| {
            Ok(GraphNode {
                id: r.get::<_, String>(0)?,
                label: r.get::<_, String>(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    // Resolve each link target name to a note path.
    let mut edge_stmt = conn.prepare(
        "SELECT src.path, tgt.path
         FROM links l
         JOIN notes src ON src.id = l.source_id
         JOIN notes tgt
           ON (tgt.path = l.target COLLATE NOCASE
               OR tgt.title = l.target COLLATE NOCASE
               OR tgt.path LIKE '%/' || l.target || '.md' COLLATE NOCASE
               OR tgt.path = l.target || '.md' COLLATE NOCASE)",
    )?;
    let edges: Vec<GraphEdge> = edge_stmt
        .query_map([], |r| {
            Ok(GraphEdge {
                source: r.get::<_, String>(0)?,
                target: r.get::<_, String>(1)?,
            })
        })?
        .collect::<rusqlite::Result<_>>()?;

    Ok(GraphData { nodes, edges })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_wikilinks() {
        let c = "See [[Alpha]] and [[Beta|the beta]] and [[Gamma#sec]] and [[Alpha]].";
        assert_eq!(extract_wikilinks(c), vec!["Alpha", "Beta", "Gamma"]);
    }

    #[test]
    fn parses_tags_not_headings() {
        let c = "# Heading\nthis is #important and #proj/sub but not a heading.";
        assert_eq!(extract_tags(c), vec!["important", "proj/sub"]);
    }

    #[test]
    fn title_prefers_h1() {
        assert_eq!(extract_title("# Real Title\nbody", "notes/foo.md"), "Real Title");
        assert_eq!(extract_title("no heading", "notes/foo.md"), "foo");
    }

    #[test]
    fn index_and_backlinks_roundtrip() {
        let conn = init_db(Path::new(":memory:")).unwrap();
        index_note(&conn, "a.md", "# A\nlinks to [[B]]", 0).unwrap();
        index_note(&conn, "b.md", "# B\nplain", 0).unwrap();
        let bl = backlinks(&conn, "B").unwrap();
        assert_eq!(bl.len(), 1);
        assert_eq!(bl[0].path, "a.md");
    }

    #[test]
    fn chunks_group_paragraphs() {
        let content = "A".repeat(700) + "\n\n" + &"B".repeat(700) + "\n\n" + "small tail";
        let chunks = chunk_content(&content, 1000);
        // Two 700-char paragraphs can't share a 1000-char chunk.
        assert!(chunks.len() >= 2);
        assert_eq!(chunks[0].0, 0);
        assert!(chunks.iter().any(|(_, t)| t.contains("small tail")));
    }

    #[test]
    fn search_finds_terms() {
        let conn = init_db(Path::new(":memory:")).unwrap();
        index_note(&conn, "a.md", "# Apple\nThe quick brown fox", 0).unwrap();
        let r = search(&conn, "brown").unwrap();
        assert_eq!(r.len(), 1);
        assert_eq!(r[0].path, "a.md");
    }
}
