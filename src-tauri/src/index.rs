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
// A list item: leading whitespace, a `-`/`*`/`+` marker, then content.
static LIST_MARKER_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"^([ \t]*)[-*+][ \t]+(.*)$").unwrap());
// A trailing `^block-id` at the very end of a line (mirrors the editor's
// BLOCK_ID_RE in src/editor/render/inline.ts).
static BLOCK_ID_TRAIL_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"[ \t]+\^([A-Za-z0-9_-]+)[ \t]*$").unwrap());
// A `((block-ref))` inline reference.
static BLOCKREF_RE: Lazy<Regex> =
    Lazy::new(|| Regex::new(r"\(\(([A-Za-z0-9_-]+)\)\)").unwrap());

#[derive(Debug, Serialize)]
pub struct Backlink {
    pub path: String,
    pub title: String,
    pub snippet: String,
}

/// A parsed block, before it is assigned a database id.
#[derive(Debug, Clone, PartialEq)]
pub struct Block {
    pub block_id: Option<String>,
    /// Index into the parsed `Vec<Block>` of the enclosing list item, if any.
    pub parent_idx: Option<usize>,
    pub line_start: i64,
    pub line_end: i64,
    pub indent: i64,
    pub kind: String,
    pub checked: Option<bool>,
    pub text: String,
}

/// A block that references a page/tag, returned grouped by source note.
#[derive(Debug, Serialize)]
pub struct BlockRef {
    pub source_path: String,
    pub source_title: String,
    pub line_start: i64,
    pub line_end: i64,
    pub indent: i64,
    pub kind: String,
    pub checked: Option<bool>,
    pub block_id: Option<String>,
    pub text: String,
}

/// The resolved location of a `^block-id`.
#[derive(Debug, Serialize)]
pub struct BlockLoc {
    pub path: String,
    pub title: String,
    pub line_start: i64,
    pub line_end: i64,
    pub text: String,
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

        -- Block-level index: every list item / paragraph / heading is an
        -- addressable block. Powers linked references, ((block refs)) and
        -- ![[note#^id]] resolution. Additive to the note-level tables above.
        CREATE TABLE IF NOT EXISTS blocks (
            id         INTEGER PRIMARY KEY,
            note_id    INTEGER NOT NULL,
            block_id   TEXT,               -- trailing ^id if present, else NULL
            parent_id  INTEGER,            -- blocks.id of the enclosing list item
            line_start INTEGER NOT NULL,   -- 0-based line
            line_end   INTEGER NOT NULL,   -- inclusive, 0-based
            indent     INTEGER NOT NULL,   -- normalized nesting depth
            kind       TEXT NOT NULL,      -- 'bullet' | 'task' | 'para' | 'heading'
            checked    INTEGER,            -- 0/1 for kind='task', else NULL
            text       TEXT NOT NULL,
            FOREIGN KEY(note_id) REFERENCES notes(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_blocks_note ON blocks(note_id);
        CREATE INDEX IF NOT EXISTS idx_blocks_blockid
            ON blocks(block_id) WHERE block_id IS NOT NULL;

        CREATE TABLE IF NOT EXISTS block_links (
            source_block INTEGER NOT NULL,
            note_id      INTEGER NOT NULL,  -- denormalized: source block's note
            target       TEXT NOT NULL,     -- page stem, tag, or ^/block id
            anchor       TEXT,              -- #heading or ^block portion, if any
            link_type    TEXT NOT NULL,     -- 'page' | 'tag' | 'blockref' | 'embed'
            FOREIGN KEY(source_block) REFERENCES blocks(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_block_links_target
            ON block_links(target COLLATE NOCASE);

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

/// Parse a note into addressable blocks (list items, paragraphs, headings).
/// Blocks inside fenced code are skipped. `indent` is a normalized nesting
/// depth derived from the leading whitespace of list items; `parent_idx` points
/// at the enclosing list item. Line numbers are 0-based. This mirrors the
/// client-side outliner block model so the index and editor agree.
pub fn parse_blocks(content: &str) -> Vec<Block> {
    let lines: Vec<&str> = content.split('\n').collect();
    let n = lines.len();

    // Mark fenced-code lines (``` or ~~~) so their contents aren't blocks.
    let mut in_code = vec![false; n];
    let mut fence: Option<char> = None;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        let is_fence = t.starts_with("```") || t.starts_with("~~~");
        match fence {
            Some(c) => {
                in_code[i] = true;
                if is_fence && t.starts_with(c) {
                    fence = None;
                }
            }
            None => {
                if is_fence {
                    fence = Some(if t.starts_with("```") { '`' } else { '~' });
                    in_code[i] = true;
                }
            }
        }
    }

    let mut blocks: Vec<Block> = Vec::new();
    // Stack of (leading-whitespace width, block index) for list-item nesting.
    let mut stack: Vec<(usize, usize)> = Vec::new();

    for i in 0..n {
        if in_code[i] {
            continue;
        }
        let raw = lines[i];
        if raw.trim().is_empty() {
            continue;
        }

        let (kind, ws_width, mut text, checked): (&str, usize, String, Option<bool>) =
            if let Some(c) = TASK_RE.captures(raw) {
                let ws = raw.len() - raw.trim_start().len();
                let done = matches!(&c[1], "x" | "X");
                ("task", ws, c[2].to_string(), Some(done))
            } else if let Some(c) = LIST_MARKER_RE.captures(raw) {
                (
                    "bullet",
                    c.get(1).map(|m| m.as_str().len()).unwrap_or(0),
                    c[2].to_string(),
                    None,
                )
            } else if HEADING_RE.is_match(raw) {
                ("heading", 0, raw.trim().to_string(), None)
            } else {
                ("para", 0, raw.trim().to_string(), None)
            };

        // Peel a trailing `^block-id` off the block text.
        let block_id = BLOCK_ID_TRAIL_RE.captures(&text).map(|c| c[1].to_string());
        if block_id.is_some() {
            text = BLOCK_ID_TRAIL_RE.replace(&text, "").to_string();
        }

        let is_list = kind == "bullet" || kind == "task";
        let (indent, parent_idx) = if is_list {
            while let Some(&(w, _)) = stack.last() {
                if w >= ws_width {
                    stack.pop();
                } else {
                    break;
                }
            }
            (stack.len() as i64, stack.last().map(|&(_, idx)| idx))
        } else {
            // Headings and paragraphs break list nesting.
            stack.clear();
            (0, None)
        };

        let idx = blocks.len();
        blocks.push(Block {
            block_id,
            parent_idx,
            line_start: i as i64,
            line_end: i as i64,
            indent,
            kind: kind.to_string(),
            checked,
            text: text.trim().to_string(),
        });
        if is_list {
            stack.push((ws_width, idx));
        }
    }
    blocks
}

/// Extract the references inside a single block's text as
/// `(target, anchor, link_type)` tuples. Unlike `extract_wikilinks`, this
/// preserves the `#heading` / `^block` anchor.
fn extract_block_links(text: &str) -> Vec<(String, Option<String>, String)> {
    let mut out = Vec::new();
    for c in WIKILINK_EMBED_RE.captures_iter(text) {
        let is_embed = &c[1] == "!";
        let body = &c[2];
        let target_part = body.split('|').next().unwrap_or(body);
        let (name, anchor) = match target_part.find('#') {
            Some(i) => (
                target_part[..i].trim(),
                Some(target_part[i + 1..].trim().to_string()),
            ),
            None => (target_part.trim(), None),
        };
        if name.is_empty() {
            continue; // e.g. a self-embed ![[#^id]] — skip for now
        }
        let link_type = if is_embed { "embed" } else { "page" };
        out.push((name.to_string(), anchor, link_type.to_string()));
    }
    for c in TAG_RE.captures_iter(text) {
        out.push((c[1].to_string(), None, "tag".to_string()));
    }
    for c in BLOCKREF_RE.captures_iter(text) {
        out.push((c[1].to_string(), None, "blockref".to_string()));
    }
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
    // Deleting blocks cascades to block_links via the foreign key.
    conn.execute("DELETE FROM blocks WHERE note_id = ?1", params![note_id])?;
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

    // Block-level index: insert parsed blocks (parents precede children, so
    // their db ids are already known) plus each block's preserved-anchor links.
    let parsed = parse_blocks(content);
    let mut block_ids: Vec<i64> = Vec::with_capacity(parsed.len());
    for b in &parsed {
        let parent_db = b.parent_idx.map(|pi| block_ids[pi]);
        conn.execute(
            "INSERT INTO blocks
                 (note_id, block_id, parent_id, line_start, line_end, indent, kind, checked, text)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
            params![
                note_id,
                b.block_id,
                parent_db,
                b.line_start,
                b.line_end,
                b.indent,
                b.kind,
                b.checked.map(|c| c as i64),
                b.text,
            ],
        )?;
        let bid = conn.last_insert_rowid();
        block_ids.push(bid);
        for (target, anchor, link_type) in extract_block_links(&b.text) {
            conn.execute(
                "INSERT INTO block_links (source_block, note_id, target, anchor, link_type)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![bid, note_id, target, anchor, link_type],
            )?;
        }
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

/// One heading section of a note, with any attached Hierarchical Context
/// Metadata (HCM) instruction. Sections are contiguous and cover the whole
/// document after the preamble (lines before the first heading).
#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct Section {
    pub level: usize,
    pub title: String,
    pub heading_line: usize,
    /// HCM instruction text (from a `<!--ai … -->` block under the heading).
    pub instruction: Option<String>,
    /// First body line (after the heading and any HCM block).
    pub body_start: usize,
    /// Exclusive end line: the next heading's line, or the line count at EOF.
    pub body_end: usize,
}

static HEADING_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(#{1,6})\s+(.*)$").unwrap());

/// Parse a note into heading sections, capturing each section's HCM instruction
/// block if one appears as the first non-blank content under the heading.
/// Headings inside fenced code blocks are ignored.
pub fn parse_sections(content: &str) -> Vec<Section> {
    let lines: Vec<&str> = content.split('\n').collect();
    let n = lines.len();

    // Mark which lines sit inside a ``` or ~~~ fenced code block.
    let mut in_code = vec![false; n];
    let mut fence: Option<char> = None;
    for (i, line) in lines.iter().enumerate() {
        let t = line.trim_start();
        let is_fence = t.starts_with("```") || t.starts_with("~~~");
        match fence {
            Some(c) => {
                in_code[i] = true; // the closing fence line is part of the block
                if is_fence && t.starts_with(c) {
                    fence = None;
                }
            }
            None => {
                if is_fence {
                    fence = Some(if t.starts_with("```") { '`' } else { '~' });
                    in_code[i] = true;
                }
            }
        }
    }

    // Heading line indices (outside code), in order.
    let heads: Vec<usize> = (0..n)
        .filter(|&i| !in_code[i] && HEADING_RE.is_match(lines[i]))
        .collect();

    let mut sections = Vec::with_capacity(heads.len());
    for (hi, &h) in heads.iter().enumerate() {
        let caps = HEADING_RE.captures(lines[h]).unwrap();
        let level = caps.get(1).unwrap().as_str().len();
        let title = caps.get(2).unwrap().as_str().trim().to_string();
        let section_end = heads.get(hi + 1).copied().unwrap_or(n);

        // Look for an HCM block as the first non-blank content under the heading.
        let mut body_start = h + 1;
        let mut instruction = None;
        let mut scan = h + 1;
        while scan < section_end && lines[scan].trim().is_empty() {
            scan += 1;
        }
        if scan < section_end && lines[scan].trim_start().starts_with("<!--") {
            if let Some((text, after)) = read_hcm_block(&lines, scan, section_end) {
                if let Some(t) = text {
                    let t = t.trim().to_string();
                    if !t.is_empty() {
                        instruction = Some(t);
                    }
                }
                body_start = after;
            }
        }

        sections.push(Section {
            level,
            title,
            heading_line: h,
            instruction,
            body_start,
            body_end: section_end,
        });
    }
    sections
}

/// If lines starting at `start` form an `<!--ai … -->` block, return its inner
/// instruction text (None if the comment isn't an `ai` block) and the line index
/// just past the closing `-->`. Returns None if it isn't a comment at all.
fn read_hcm_block(
    lines: &[&str],
    start: usize,
    end: usize,
) -> Option<(Option<String>, usize)> {
    let first = lines[start].trim_start();
    let rest = first.strip_prefix("<!--")?;
    // Is it marked `ai`? (`<!--ai` or `<!-- ai`)
    let is_ai = rest.trim_start().starts_with("ai");

    // Collect the comment text until `-->`.
    let mut inner = String::new();
    for i in start..end {
        let line = lines[i];
        let mut seg = if i == start { first } else { line };
        if i == start {
            seg = seg.strip_prefix("<!--").unwrap_or(seg);
        }
        if let Some(idx) = seg.find("-->") {
            inner.push_str(&seg[..idx]);
            let body_after = if i == start {
                // Inline single-line comment: body continues on the same line.
                start + 1
            } else {
                i + 1
            };
            if is_ai {
                let mut text = inner;
                // Drop the leading `ai` marker token.
                let trimmed = text.trim_start();
                if let Some(t) = trimmed.strip_prefix("ai") {
                    text = t.to_string();
                }
                return Some((Some(text), body_after));
            }
            return Some((None, body_after));
        }
        inner.push_str(seg);
        inner.push('\n');
    }
    // Unterminated comment — treat the rest of the section as the block.
    if is_ai {
        let trimmed = inner.trim_start();
        let text = trimmed.strip_prefix("ai").unwrap_or(trimmed).to_string();
        return Some((Some(text), end));
    }
    Some((None, end))
}

/// Parent-section instructions for `sections[i]`, nearest ancestor last, built
/// from the heading-level stack (for HCM contextual inheritance).
pub fn ancestors(sections: &[Section], i: usize) -> Vec<String> {
    let mut out = Vec::new();
    let mut level = sections[i].level;
    for j in (0..i).rev() {
        if sections[j].level < level {
            if let Some(ins) = &sections[j].instruction {
                out.push(ins.clone());
            }
            level = sections[j].level;
            if level == 1 {
                break;
            }
        }
    }
    out.reverse();
    out
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
        "DELETE FROM notes; DELETE FROM links; DELETE FROM tags; DELETE FROM aliases; DELETE FROM fields; DELETE FROM tasks; DELETE FROM block_links; DELETE FROM blocks; DELETE FROM notes_fts;",
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

/// Every block that references `name` (a page stem or tag), ordered so callers
/// can group by source note. This is the "linked references" data source.
pub fn block_backlinks(conn: &Connection, name: &str) -> rusqlite::Result<Vec<BlockRef>> {
    let key = name.trim().trim_start_matches('#');
    let mut stmt = conn.prepare(
        "SELECT n.path, n.title, b.line_start, b.line_end, b.indent, b.kind, b.checked, b.block_id, b.text
         FROM block_links bl
         JOIN blocks b ON b.id = bl.source_block
         JOIN notes  n ON n.id = b.note_id
         WHERE bl.target = ?1 COLLATE NOCASE
           AND bl.link_type IN ('page', 'embed', 'tag')
         ORDER BY n.path, b.line_start",
    )?;
    let rows = stmt.query_map(params![key], |r| {
        Ok(BlockRef {
            source_path: r.get(0)?,
            source_title: r.get(1)?,
            line_start: r.get(2)?,
            line_end: r.get(3)?,
            indent: r.get(4)?,
            kind: r.get(5)?,
            checked: r.get::<_, Option<i64>>(6)?.map(|c| c != 0),
            block_id: r.get(7)?,
            text: r.get(8)?,
        })
    })?;
    rows.collect()
}

/// Resolve a `^block-id` (with or without the leading `^`) to its note + range.
pub fn resolve_block(conn: &Connection, block_id: &str) -> rusqlite::Result<Option<BlockLoc>> {
    let id = block_id.trim().trim_start_matches('^');
    let mut stmt = conn.prepare(
        "SELECT n.path, n.title, b.line_start, b.line_end, b.text
         FROM blocks b JOIN notes n ON n.id = b.note_id
         WHERE b.block_id = ?1 LIMIT 1",
    )?;
    stmt.query_row(params![id], |r| {
        Ok(BlockLoc {
            path: r.get(0)?,
            title: r.get(1)?,
            line_start: r.get(2)?,
            line_end: r.get(3)?,
            text: r.get(4)?,
        })
    })
    .optional()
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
    fn sections_capture_hcm_and_ranges() {
        let c = "---\nk: v\n---\nintro\n\n# Meeting\n<!--ai\nExtract action items.\n-->\nraw text\nmore\n\n## Tasks\nbody\n";
        let secs = parse_sections(c);
        assert_eq!(secs.len(), 2);
        // # Meeting at line 5 (0-based), HCM lines 6-8, body starts line 8.
        assert_eq!(secs[0].level, 1);
        assert_eq!(secs[0].title, "Meeting");
        assert_eq!(secs[0].heading_line, 5);
        assert_eq!(secs[0].instruction.as_deref(), Some("Extract action items."));
        assert_eq!(secs[0].body_start, 9);
        // body_end is the next heading line.
        assert_eq!(secs[0].body_end, secs[1].heading_line);
        // ## Tasks has no HCM.
        assert_eq!(secs[1].level, 2);
        assert_eq!(secs[1].instruction, None);
        assert_eq!(secs[1].body_start, secs[1].heading_line + 1);
    }

    #[test]
    fn sections_inline_hcm_and_inheritance() {
        let c = "# Project\n<!--ai tone: terse-->\np\n\n## Sub\n<!--ai bullets-->\nx\n";
        let secs = parse_sections(c);
        assert_eq!(secs[0].instruction.as_deref(), Some("tone: terse"));
        assert_eq!(secs[1].instruction.as_deref(), Some("bullets"));
        // The ## Sub section inherits the # Project instruction.
        assert_eq!(ancestors(&secs, 1), vec!["tone: terse".to_string()]);
        assert_eq!(ancestors(&secs, 0), Vec::<String>::new());
    }

    #[test]
    fn sections_skip_fenced_code_headings() {
        let c = "# Real\n```\n# not a heading\n```\nbody\n";
        let secs = parse_sections(c);
        assert_eq!(secs.len(), 1);
        assert_eq!(secs[0].title, "Real");
    }

    #[test]
    fn sections_reconstruct_roundtrip() {
        // The section ranges must tile the document exactly after the preamble,
        // so reassembling them (no regeneration) reproduces the input.
        let c = "intro line\n\n# A\n<!--ai do x-->\nbody a\n\n## B\nbody b\nlast\n";
        let lines: Vec<&str> = c.split('\n').collect();
        let secs = parse_sections(c);
        let first = secs.first().map(|s| s.heading_line).unwrap_or(lines.len());
        let mut out: Vec<&str> = lines[..first].to_vec();
        for s in &secs {
            out.extend_from_slice(&lines[s.heading_line..s.body_end]);
        }
        assert_eq!(out, lines);
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
    fn parses_blocks_with_nesting_and_ids() {
        let c = "# Title\n- parent [[Alpha]]\n  - child #tag\n  - [ ] task ^t1\n\nplain para\n";
        let blocks = parse_blocks(c);
        // heading, parent bullet, child bullet, task, para
        assert_eq!(blocks.len(), 5);
        assert_eq!(blocks[0].kind, "heading");
        assert_eq!(blocks[1].kind, "bullet");
        assert_eq!(blocks[1].indent, 0);
        assert_eq!(blocks[1].text, "parent [[Alpha]]");
        assert_eq!(blocks[2].indent, 1);
        assert_eq!(blocks[2].parent_idx, Some(1));
        assert_eq!(blocks[3].kind, "task");
        assert_eq!(blocks[3].checked, Some(false));
        assert_eq!(blocks[3].indent, 1);
        assert_eq!(blocks[3].block_id.as_deref(), Some("t1"));
        assert_eq!(blocks[3].text, "task"); // ^t1 peeled off
        assert_eq!(blocks[4].kind, "para");
        assert_eq!(blocks[4].parent_idx, None);
    }

    #[test]
    fn block_links_preserve_anchors() {
        let links = extract_block_links("see [[Note#^abc]] and ![[Other#Heading]] and ((xyz)) #tag");
        assert!(links.contains(&("Note".into(), Some("^abc".into()), "page".into())));
        assert!(links.contains(&("Other".into(), Some("Heading".into()), "embed".into())));
        assert!(links.contains(&("xyz".into(), None, "blockref".into())));
        assert!(links.contains(&("tag".into(), None, "tag".into())));
    }

    #[test]
    fn block_backlinks_and_resolve_roundtrip() {
        let conn = init_db(Path::new(":memory:")).unwrap();
        index_note(&conn, "daily/2026-07-10.md", "- met [[Project X]] re scope\n- unrelated", 0).unwrap();
        index_note(&conn, "notes/anchor.md", "- a decision ^dec1", 0).unwrap();
        let refs = block_backlinks(&conn, "Project X").unwrap();
        assert_eq!(refs.len(), 1);
        assert_eq!(refs[0].source_path, "daily/2026-07-10.md");
        assert_eq!(refs[0].text, "met [[Project X]] re scope");
        assert_eq!(refs[0].line_start, 0);
        let loc = resolve_block(&conn, "^dec1").unwrap().unwrap();
        assert_eq!(loc.path, "notes/anchor.md");
        assert_eq!(loc.text, "a decision");
    }

    #[test]
    fn blocks_skip_fenced_code() {
        let c = "- real\n```\n- not a block\n[[NotLinked]]\n```\n- also real";
        let blocks = parse_blocks(c);
        assert_eq!(blocks.len(), 2);
        assert_eq!(blocks[0].text, "real");
        assert_eq!(blocks[1].text, "also real");
    }

    #[test]
    fn demo_vault_nimbus_primitives() {
        // Verifies the sample-vault Project Nimbus demo produces the expected
        // linked references for the todo/notes/mentions primitives.
        let conn = init_db(Path::new(":memory:")).unwrap();
        let files = [
            "../sample-vault/Daily/2026-07-06.md",
            "../sample-vault/Daily/2026-07-07.md",
            "../sample-vault/Daily/2026-07-08.md",
            "../sample-vault/Daily/2026-07-10.md",
            "../sample-vault/Nimbus Field Notes.md",
            "../sample-vault/Project Nimbus.md",
        ];
        for f in files {
            let content = std::fs::read_to_string(f).unwrap_or_default();
            let rel = f.trim_start_matches("../sample-vault/");
            index_note(&conn, rel, &content, 0).unwrap();
        }
        let refs = block_backlinks(&conn, "Project Nimbus").unwrap();
        // Exclude the page's own note (the primitives do this client-side).
        let external: Vec<&BlockRef> =
            refs.iter().filter(|r| r.source_path != "Project Nimbus.md").collect();
        let tasks = external.iter().filter(|r| r.kind == "task").count();
        let open = external
            .iter()
            .filter(|r| r.kind == "task" && r.checked == Some(false))
            .count();
        let notes = external
            .iter()
            .filter(|r| r.kind == "bullet" || r.kind == "para")
            .count();
        // Robust invariants (the demo notes are user-editable, so avoid exact
        // counts): the primitives see a healthy mix of open + done tasks and
        // several note blocks referencing the page.
        let done = tasks - open;
        assert!(tasks >= 8, "todo primitive should see the journal tasks (got {tasks})");
        assert!(open >= 1 && done >= 1, "a mix of open ({open}) and done ({done}) tasks");
        assert!(notes >= 7, "notes primitive should see the note blocks (got {notes})");
        // Heuristic material for the atom-backed primitives (decisions / pains /
        // insights surface these journal blocks even before Atoms synthesis).
        let has = |re: &str| {
            let low = re.to_lowercase();
            external.iter().any(|r| r.text.to_lowercase().starts_with(&low))
        };
        assert!(has("decision"), "a Decision: block should exist");
        assert!(has("problem") || has("blocker"), "a Problem/Blocker block should exist");
        assert!(has("insight"), "an Insight: block should exist");
        // The 2026-07-10 journal alone feeds all three primitives.
        let from_710 = external
            .iter()
            .filter(|r| r.source_path == "Daily/2026-07-10.md")
            .count();
        let tasks_710 = external
            .iter()
            .filter(|r| r.source_path == "Daily/2026-07-10.md" && r.kind == "task")
            .count();
        assert!(from_710 >= 6, "the 2026-07-10 note should mention Nimbus many times");
        assert!(tasks_710 >= 3, "and contribute several tasks");
        // The ^nimbus-kickoff block resolves (for ((block-ref)) / embeds).
        let loc = resolve_block(&conn, "nimbus-kickoff").unwrap().unwrap();
        assert_eq!(loc.path, "Daily/2026-07-06.md");
        assert!(loc.text.contains("Kicked off"));
    }

    #[test]
    fn frontmatter_type_and_parent_expose_in_pages() {
        // Backs the categories/hierarchy feature: a note's `type:` and a
        // quoted `parent: "[[X]]"` frontmatter must surface in Page.fields.
        let conn = init_db(Path::new(":memory:")).unwrap();
        index_note(
            &conn,
            "Projects/Aurora Web Dashboard.md",
            "---\ntype: project\nparent: \"[[Project Aurora]]\"\n---\n# Aurora Web Dashboard\n",
            0,
        )
        .unwrap();
        let ps = pages(&conn, Path::new(".")).unwrap();
        let p = ps.iter().find(|p| p.name == "Aurora Web Dashboard").unwrap();
        assert_eq!(p.folder, "Projects");
        assert_eq!(p.fields.get("type").and_then(|v| v.as_str()), Some("project"));
        assert_eq!(
            p.fields.get("parent").and_then(|v| v.as_str()),
            Some("[[Project Aurora]]"),
        );
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
