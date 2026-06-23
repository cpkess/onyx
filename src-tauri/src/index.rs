//! Markdown indexing: note metadata, wikilinks, tags, backlinks and full-text
//! search, all stored in a single SQLite database living at `<vault>/.onyx/onyx.db`.

use once_cell::sync::Lazy;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use std::collections::HashMap;
use std::path::Path;
use walkdir::WalkDir;

static WIKILINK_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\[\[([^\]]+)\]\]").unwrap());
// Captures optional `!` embed prefix + the body, for link rewriting on rename.
static WIKILINK_EMBED_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(!?)\[\[([^\]\n]+)\]\]").unwrap());
// A tag is `#` immediately followed by a word char (so markdown headings like
// "# Title", which have a space after `#`, are not matched).
static TAG_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?:^|[^\w&])#([A-Za-z0-9_][A-Za-z0-9_/-]*)").unwrap());
static H1_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?m)^#\s+(.+)$").unwrap());
// Standalone inline field at line start: `Key:: value`
static INLINE_FIELD_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"(?m)^[ \t>]*([A-Za-z][\w \-/]*?)::[ \t]*(.*)$").unwrap());
// Bracketed inline field: `[key:: value]` or `(key:: value)`
static INLINE_FIELD_BRACKET_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[\[(]([A-Za-z][\w \-/]*?)::[ \t]*([^\])]*)[\])]").unwrap());
static TASK_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^[ \t]*[-*+] \[([ xX])\]\s+(.*)$").unwrap());

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

        CREATE TABLE IF NOT EXISTS aliases (
            note_id INTEGER NOT NULL,
            alias   TEXT NOT NULL,
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_aliases_alias ON aliases(alias);

        CREATE TABLE IF NOT EXISTS fields (
            note_id INTEGER NOT NULL,
            key     TEXT NOT NULL,
            value   TEXT NOT NULL,   -- JSON-encoded value
            source  TEXT NOT NULL,   -- 'fm' | 'inline'
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_fields_note ON fields(note_id);

        CREATE TABLE IF NOT EXISTS tasks (
            note_id INTEGER NOT NULL,
            text    TEXT NOT NULL,
            checked INTEGER NOT NULL,
            line    INTEGER NOT NULL,
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_tasks_note ON tasks(note_id);

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

/// Rewrite every `[[old]]` / `![[old]]` (and `old|alias`, `old#sec`) to `new`,
/// preserving alias/section/embed. Returns the new content and the rewrite count.
pub fn rewrite_wikilinks(content: &str, old_name: &str, new_name: &str) -> (String, usize) {
    let mut count = 0usize;
    let out = WIKILINK_EMBED_RE.replace_all(content, |caps: &regex::Captures| {
        let bang = &caps[1];
        let body = &caps[2];
        let (target, rest) = match body.find('|') {
            Some(i) => (&body[..i], &body[i..]),
            None => (body, ""),
        };
        let (name, sec) = match target.find('#') {
            Some(i) => (&target[..i], &target[i..]),
            None => (target, ""),
        };
        if name.trim().eq_ignore_ascii_case(old_name) {
            count += 1;
            format!("{bang}[[{new_name}{sec}{rest}]]")
        } else {
            caps[0].to_string()
        }
    });
    (out.into_owned(), count)
}

/// Parse frontmatter `aliases:` (inline `[a, b]` or a `- item` list) into names.
pub fn extract_aliases(content: &str) -> Vec<String> {
    // Frontmatter must be a leading `---` fenced block.
    let rest = match content.strip_prefix("---\n") {
        Some(r) => r,
        None => return vec![],
    };
    let end = match rest.find("\n---") {
        Some(i) => i,
        None => return vec![],
    };
    let fm = &rest[..end];

    let mut out: Vec<String> = Vec::new();
    let mut lines = fm.lines().peekable();
    while let Some(line) = lines.next() {
        let trimmed = line.trim_start();
        if let Some(after) = trimmed.strip_prefix("aliases:") {
            let after = after.trim();
            if after.starts_with('[') {
                // Inline list: aliases: [a, "b"]
                for part in after.trim_matches(['[', ']']).split(',') {
                    let v = part.trim().trim_matches(['"', '\'']).trim();
                    if !v.is_empty() {
                        out.push(v.to_string());
                    }
                }
            } else if !after.is_empty() {
                // Single scalar: aliases: foo
                out.push(after.trim_matches(['"', '\'']).to_string());
            } else {
                // Block list of "- item" lines.
                while let Some(next) = lines.peek() {
                    let t = next.trim_start();
                    if let Some(item) = t.strip_prefix("- ") {
                        let v = item.trim().trim_matches(['"', '\'']).trim();
                        if !v.is_empty() {
                            out.push(v.to_string());
                        }
                        lines.next();
                    } else {
                        break;
                    }
                }
            }
            break;
        }
    }
    out
}

/// The leading `---` frontmatter block, if present.
fn frontmatter_str(content: &str) -> Option<&str> {
    let rest = content.strip_prefix("---\n")?;
    let end = rest.find("\n---")?;
    Some(&rest[..end])
}

/// Dataview-style key sanitization: trim, lowercase, spaces → dashes.
fn sanitize_key(k: &str) -> String {
    k.trim().to_lowercase().replace(' ', "-")
}

/// Parse YAML frontmatter into `(key, value_json)` pairs (one row per top-level key).
pub fn extract_frontmatter_fields(content: &str) -> Vec<(String, String)> {
    let fm = match frontmatter_str(content) {
        Some(f) => f,
        None => return vec![],
    };
    let yaml: serde_yaml::Value = match serde_yaml::from_str(fm) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let json: serde_json::Value = match serde_json::to_value(yaml) {
        Ok(v) => v,
        Err(_) => return vec![],
    };
    let mut out = Vec::new();
    if let serde_json::Value::Object(map) = json {
        for (k, v) in map {
            out.push((sanitize_key(&k), v.to_string()));
        }
    }
    out
}

/// Parse inline `Key:: value`, `[k:: v]`, `(k:: v)` fields into `(key, value_json)`.
pub fn extract_inline_fields(content: &str) -> Vec<(String, String)> {
    // Skip the frontmatter region so `key: value` YAML isn't double-counted.
    let body_start = frontmatter_str(content)
        .map(|fm| content.find(fm).unwrap_or(0) + fm.len() + 4)
        .unwrap_or(0);
    let body = &content[body_start.min(content.len())..];

    let mut out = Vec::new();
    let mut push = |k: &str, v: &str| {
        let key = sanitize_key(k);
        if !key.is_empty() {
            out.push((key, serde_json::Value::String(v.trim().to_string()).to_string()));
        }
    };
    for c in INLINE_FIELD_RE.captures_iter(body) {
        // Don't capture markdown headings or `::` inside code; the regex already
        // requires a leading word char, which excludes most false positives.
        push(&c[1], &c[2]);
    }
    for c in INLINE_FIELD_BRACKET_RE.captures_iter(body) {
        push(&c[1], &c[2]);
    }
    out
}

/// Parse GFM task list items into `(text, checked, line_number)` (0-based line).
pub fn extract_tasks(content: &str) -> Vec<(String, bool, i64)> {
    let mut out = Vec::new();
    for (i, line) in content.lines().enumerate() {
        if let Some(c) = TASK_RE.captures(line) {
            let checked = matches!(&c[1], "x" | "X");
            out.push((c[2].trim().to_string(), checked, i as i64));
        }
    }
    out
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
    conn.execute("DELETE FROM aliases WHERE note_id = ?1", params![note_id])?;
    conn.execute("DELETE FROM fields WHERE note_id = ?1", params![note_id])?;
    conn.execute("DELETE FROM tasks WHERE note_id = ?1", params![note_id])?;
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
    for alias in extract_aliases(content) {
        conn.execute(
            "INSERT INTO aliases (note_id, alias) VALUES (?1, ?2)",
            params![note_id, alias],
        )?;
    }
    for (key, value) in extract_frontmatter_fields(content) {
        conn.execute(
            "INSERT INTO fields (note_id, key, value, source) VALUES (?1, ?2, ?3, 'fm')",
            params![note_id, key, value],
        )?;
    }
    for (key, value) in extract_inline_fields(content) {
        conn.execute(
            "INSERT INTO fields (note_id, key, value, source) VALUES (?1, ?2, ?3, 'inline')",
            params![note_id, key, value],
        )?;
    }
    for (text, checked, line) in extract_tasks(content) {
        conn.execute(
            "INSERT INTO tasks (note_id, text, checked, line) VALUES (?1, ?2, ?3, ?4)",
            params![note_id, text, checked as i64, line],
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
        "DELETE FROM notes; DELETE FROM links; DELETE FROM tags; DELETE FROM aliases; DELETE FROM fields; DELETE FROM tasks; DELETE FROM notes_fts;",
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

/// All note names (file stems) plus aliases, for wikilink autocomplete/existence.
pub fn all_note_names(conn: &Connection) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare("SELECT path FROM notes ORDER BY path")?;
    let rows = stmt.query_map([], |r| r.get::<_, String>(0))?;
    let mut names = Vec::new();
    for r in rows {
        names.push(note_name(&r?));
    }
    let mut astmt = conn.prepare("SELECT alias FROM aliases")?;
    for a in astmt.query_map([], |r| r.get::<_, String>(0))? {
        names.push(a?);
    }
    names.sort();
    names.dedup();
    Ok(names)
}

/// Resolve a wikilink name to a note path via file stem or alias.
pub fn resolve_name(conn: &Connection, name: &str) -> rusqlite::Result<Option<String>> {
    let target = name.to_lowercase();
    let mut stmt = conn.prepare("SELECT path FROM notes")?;
    let paths: Vec<String> = stmt
        .query_map([], |r| r.get::<_, String>(0))?
        .filter_map(|r| r.ok())
        .collect();
    if let Some(p) = paths.iter().find(|p| note_name(p).to_lowercase() == target) {
        return Ok(Some(p.clone()));
    }
    // Alias fallback.
    let mut astmt = conn.prepare(
        "SELECT n.path FROM aliases a JOIN notes n ON n.id = a.note_id
         WHERE a.alias = ?1 COLLATE NOCASE LIMIT 1",
    )?;
    astmt
        .query_row(params![name], |r| r.get::<_, String>(0))
        .optional()
}

/// All tags with their note counts, most-used first.
pub fn tags(conn: &Connection) -> rusqlite::Result<Vec<(String, i64)>> {
    let mut stmt = conn.prepare(
        "SELECT tag, COUNT(DISTINCT note_id) c FROM tags GROUP BY tag ORDER BY c DESC, tag",
    )?;
    let rows: rusqlite::Result<Vec<(String, i64)>> = stmt
        .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))?
        .collect();
    rows
}

/// Note paths carrying a given tag.
pub fn notes_by_tag(conn: &Connection, tag: &str) -> rusqlite::Result<Vec<String>> {
    let mut stmt = conn.prepare(
        "SELECT DISTINCT n.path FROM tags t JOIN notes n ON n.id = t.note_id
         WHERE t.tag = ?1 COLLATE NOCASE ORDER BY n.path",
    )?;
    let rows: rusqlite::Result<Vec<String>> = stmt
        .query_map(params![tag.trim_start_matches('#')], |r| r.get::<_, String>(0))?
        .collect();
    rows
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

#[derive(Debug, Serialize)]
pub struct PageTask {
    pub text: String,
    pub checked: bool,
    pub line: i64,
    pub path: String,
}

/// A queryable "page" for the Dataview engine: a note plus its metadata.
#[derive(Debug, Serialize)]
pub struct Page {
    pub path: String,
    pub name: String,
    pub folder: String,
    pub tags: Vec<String>,
    pub mtime: i64,
    pub ctime: i64,
    pub size: i64,
    pub fields: serde_json::Value, // object of frontmatter + inline fields
    pub tasks: Vec<PageTask>,
    pub outlinks: Vec<String>, // resolved note paths
    pub inlinks: Vec<String>,
}

/// Assemble every note into a `Page` with frontmatter/inline fields, tasks,
/// tags and resolved in/out links. Used by the Dataview query engine.
pub fn pages(conn: &Connection, root: &Path) -> rusqlite::Result<Vec<Page>> {
    let mut ns = conn.prepare("SELECT id, path, mtime FROM notes")?;
    let notes: Vec<(i64, String, i64)> = ns
        .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
        .collect::<rusqlite::Result<_>>()?;

    // name (stem) + alias -> path, for link resolution.
    let mut name_to_path: HashMap<String, String> = HashMap::new();
    for (_, p, _) in &notes {
        name_to_path.insert(note_name(p).to_lowercase(), p.clone());
    }
    {
        let mut al = conn.prepare("SELECT a.alias, n.path FROM aliases a JOIN notes n ON n.id = a.note_id")?;
        for row in al.query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))? {
            let (a, p) = row?;
            name_to_path.entry(a.to_lowercase()).or_insert(p);
        }
    }

    let mut tags_by: HashMap<i64, Vec<String>> = HashMap::new();
    {
        let mut tg = conn.prepare("SELECT note_id, tag FROM tags")?;
        for row in tg.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (id, t) = row?;
            tags_by.entry(id).or_default().push(t);
        }
    }

    let mut fields_by: HashMap<i64, serde_json::Map<String, serde_json::Value>> = HashMap::new();
    {
        let mut fl = conn.prepare("SELECT note_id, key, value FROM fields")?;
        for row in fl.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?))
        })? {
            let (id, k, vjson) = row?;
            let v: serde_json::Value =
                serde_json::from_str(&vjson).unwrap_or(serde_json::Value::String(vjson));
            let map = fields_by.entry(id).or_default();
            match map.get_mut(&k) {
                Some(serde_json::Value::Array(arr)) => arr.push(v),
                Some(existing) => {
                    *existing = serde_json::Value::Array(vec![existing.clone(), v]);
                }
                None => {
                    map.insert(k, v);
                }
            }
        }
    }

    let mut tasks_by: HashMap<i64, Vec<(String, bool, i64)>> = HashMap::new();
    {
        let mut tk = conn.prepare("SELECT note_id, text, checked, line FROM tasks ORDER BY line")?;
        for row in tk.query_map([], |r| {
            Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?, r.get::<_, i64>(2)?, r.get::<_, i64>(3)?))
        })? {
            let (id, t, c, l) = row?;
            tasks_by.entry(id).or_default().push((t, c != 0, l));
        }
    }

    let id_to_path: HashMap<i64, String> =
        notes.iter().map(|(id, p, _)| (*id, p.clone())).collect();
    let mut outlinks_by: HashMap<i64, Vec<String>> = HashMap::new();
    let mut inlinks_by: HashMap<String, Vec<String>> = HashMap::new();
    {
        let mut lk = conn.prepare("SELECT source_id, target FROM links")?;
        for row in lk.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))? {
            let (sid, target) = row?;
            let tname = target
                .split('#')
                .next()
                .unwrap_or(&target)
                .split('|')
                .next()
                .unwrap_or(&target)
                .trim()
                .to_lowercase();
            if let Some(tp) = name_to_path.get(&tname) {
                outlinks_by.entry(sid).or_default().push(tp.clone());
                if let Some(sp) = id_to_path.get(&sid) {
                    inlinks_by.entry(tp.clone()).or_default().push(sp.clone());
                }
            }
        }
    }

    let mut out = Vec::with_capacity(notes.len());
    for (id, path, mtime) in &notes {
        let (ctime, size) = std::fs::metadata(root.join(path))
            .map(|m| {
                let ct = m
                    .created()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|d| d.as_secs() as i64)
                    .unwrap_or(0);
                (ct, m.len() as i64)
            })
            .unwrap_or((0, 0));
        let folder = Path::new(path)
            .parent()
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();
        let tasks = tasks_by
            .remove(id)
            .unwrap_or_default()
            .into_iter()
            .map(|(text, checked, line)| PageTask { text, checked, line, path: path.clone() })
            .collect();
        out.push(Page {
            path: path.clone(),
            name: note_name(path),
            folder,
            tags: tags_by.remove(id).unwrap_or_default(),
            mtime: *mtime,
            ctime,
            size,
            fields: serde_json::Value::Object(fields_by.remove(id).unwrap_or_default()),
            tasks,
            outlinks: outlinks_by.remove(id).unwrap_or_default(),
            inlinks: inlinks_by.remove(path).unwrap_or_default(),
        });
    }
    Ok(out)
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
    fn parses_frontmatter_and_inline_fields() {
        let c = "---\nstatus: reading\nRating: 9\n---\nrating:: 8\nprose with a [due:: 2026-07-01] field";
        let fm = extract_frontmatter_fields(c);
        let keys: Vec<&str> = fm.iter().map(|(k, _)| k.as_str()).collect();
        assert!(keys.contains(&"status"), "frontmatter fields: {fm:?}");
        assert!(keys.contains(&"rating"), "frontmatter fields: {fm:?}");
        let inline = extract_inline_fields(c);
        assert!(inline.iter().any(|(k, _)| k == "rating"), "inline: {inline:?}");
        assert!(inline.iter().any(|(k, _)| k == "due"), "inline: {inline:?}");
    }

    #[test]
    fn parses_tasks_with_lines() {
        let c = "intro\n- [ ] todo one\n- [x] done two\nplain";
        let tasks = extract_tasks(c);
        assert_eq!(tasks.len(), 2);
        assert_eq!(tasks[0], ("todo one".into(), false, 1));
        assert_eq!(tasks[1], ("done two".into(), true, 2));
    }

    #[test]
    fn parses_aliases_inline_and_block() {
        let inline = "---\ntitle: X\naliases: [Foo, \"Bar Baz\"]\n---\nbody";
        assert_eq!(extract_aliases(inline), vec!["Foo", "Bar Baz"]);
        let block = "---\naliases:\n  - One\n  - Two\n---\nbody";
        assert_eq!(extract_aliases(block), vec!["One", "Two"]);
        assert_eq!(extract_aliases("no frontmatter"), Vec::<String>::new());
    }

    #[test]
    fn rewrites_links_on_rename() {
        let c = "See [[Old]] and [[Old|alias]] and [[Old#Heading]] and ![[Old]] and [[Other]].";
        let (out, n) = rewrite_wikilinks(c, "Old", "New");
        assert_eq!(n, 4);
        assert_eq!(
            out,
            "See [[New]] and [[New|alias]] and [[New#Heading]] and ![[New]] and [[Other]]."
        );
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
