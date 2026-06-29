//! The `#[tauri::command]` surface the React UI calls via `invoke`.

use std::collections::HashSet;

use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::ai::{self, AiConfig, ChatMessage};
use crate::index::{self, Backlink, GraphData, SearchResult};
use crate::vault::{self, AppState, TreeNode, VaultInfo};
use crate::vector::{self, SemanticHit};

/// Run a closure with the open vault, returning an error if none is open.
pub fn with_vault<T, F>(state: &State<AppState>, f: F) -> Result<T, String>
where
    F: FnOnce(&vault::VaultCtx) -> Result<T, String>,
{
    let guard = state.vault.lock().unwrap();
    let ctx = guard.as_ref().ok_or("No vault is open")?;
    f(ctx)
}

#[derive(Debug, Serialize)]
pub struct LinkSuggestion {
    pub name: String,
    pub path: String,
    pub reason: String,
}

#[derive(Debug, Serialize)]
pub struct AiDocument {
    pub title: String,
    pub content: String,
}

fn msg(role: &str, content: String) -> ChatMessage {
    ChatMessage {
        role: role.to_string(),
        content,
    }
}

/// Truncate to roughly `n` chars (keeps prompts within model context).
fn truncate(s: &str, n: usize) -> String {
    if s.chars().count() <= n {
        s.to_string()
    } else {
        s.chars().take(n).collect::<String>() + "…"
    }
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Quote a value as a YAML double-quoted scalar (so it survives round-tripping).
fn yaml_quote(s: &str) -> String {
    format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
}

/// Read one flat frontmatter key from a note's content (handles quoted values).
fn frontmatter_value(content: &str, key: &str) -> Option<String> {
    let body = content.strip_prefix("---\n")?;
    let end = body.find("\n---")?;
    for line in body[..end].lines() {
        let line = line.trim();
        if let Some(rest) = line.strip_prefix(key) {
            if let Some(v) = rest.trim_start().strip_prefix(':') {
                let v = v.trim();
                if v.len() >= 2 && v.starts_with('"') && v.ends_with('"') {
                    return Some(v[1..v.len() - 1].replace("\\\"", "\"").replace("\\\\", "\\"));
                }
                return Some(v.to_string());
            }
        }
    }
    None
}

/// Extract the first JSON array found in a model response.
fn json_array(s: &str) -> Option<Vec<serde_json::Value>> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end <= start {
        return None;
    }
    serde_json::from_str::<Vec<serde_json::Value>>(&s[start..=end]).ok()
}

#[tauri::command]
pub fn get_last_vault(app: AppHandle) -> Option<String> {
    vault::load_last_vault(&app)
}

#[tauri::command]
pub fn open_vault(app: AppHandle, path: String) -> Result<VaultInfo, String> {
    let info = vault::open(&app, &path)?;
    // Open the Night Shift assistant database for this vault.
    crate::night::on_vault_opened(&app, std::path::Path::new(&path));
    Ok(info)
}

#[tauri::command]
pub fn get_tree(state: State<AppState>) -> Result<Vec<TreeNode>, String> {
    with_vault(&state, |ctx| Ok(vault::build_tree(&ctx.root)))
}

#[tauri::command]
pub fn read_note(state: State<AppState>, path: String) -> Result<String, String> {
    with_vault(&state, |ctx| {
        let abs = vault::resolve(&ctx.root, &path)?;
        std::fs::read_to_string(&abs).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn write_note(state: State<AppState>, path: String, content: String) -> Result<(), String> {
    with_vault(&state, |ctx| {
        let abs = vault::resolve(&ctx.root, &path)?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&abs, &content).map_err(|e| e.to_string())?;
        let mtime = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_secs() as i64)
            .unwrap_or(0);
        index::index_note(&ctx.conn, &path, &content, mtime).map_err(|e| e.to_string())
    })
}

/// Create a note (adding `.md` if missing). Errors if it already exists.
#[tauri::command]
pub fn create_note(state: State<AppState>, path: String) -> Result<String, String> {
    with_vault(&state, |ctx| {
        let mut rel = path.trim().trim_start_matches('/').to_string();
        if !rel.to_lowercase().ends_with(".md") {
            rel.push_str(".md");
        }
        let abs = vault::resolve(&ctx.root, &rel)?;
        if abs.exists() {
            return Ok(rel);
        }
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&abs, "").map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, &rel, "", 0).map_err(|e| e.to_string())?;
        Ok(rel)
    })
}

/// Run a non-streaming chat completion (used by StreamWeaver for structured output).
#[tauri::command]
pub async fn ai_complete(app: AppHandle, messages: Vec<ChatMessage>) -> Result<String, String> {
    let cfg = ai::load_config(&app);
    ai::chat_complete(&cfg, messages).await
}

/// Append `text` under a `## heading` section of a note (creating the note and/or
/// the section if missing). Used for block distribution and the central Tasks file.
#[tauri::command]
pub fn append_to_note(
    state: State<AppState>,
    path: String,
    heading: String,
    text: String,
) -> Result<(), String> {
    with_vault(&state, |ctx| {
        let mut rel = path.trim().trim_start_matches('/').to_string();
        if !rel.to_lowercase().ends_with(".md") {
            rel.push_str(".md");
        }
        let abs = vault::resolve(&ctx.root, &rel)?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let content = std::fs::read_to_string(&abs).unwrap_or_default();
        let mut lines: Vec<String> = content.split('\n').map(String::from).collect();
        let h = heading.trim();

        if h.is_empty() {
            lines.push(text);
        } else {
            let head_line = format!("## {h}");
            let idx = lines.iter().position(|l| l.trim() == head_line);
            match idx {
                Some(i) => {
                    // Insert before the next heading (end of this section), else at end.
                    let mut end = lines.len();
                    for j in (i + 1)..lines.len() {
                        if lines[j].trim_start().starts_with('#') {
                            end = j;
                            break;
                        }
                    }
                    lines.insert(end, text);
                }
                None => {
                    if lines.last().map(|l| !l.is_empty()).unwrap_or(false) {
                        lines.push(String::new());
                    }
                    lines.push(head_line);
                    lines.push(text);
                }
            }
        }
        let new_content = lines.join("\n");
        std::fs::write(&abs, &new_content).map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, &rel, &new_content, now_secs()).map_err(|e| e.to_string())
    })
}

/// Resolve an image/asset reference to an absolute filesystem path the webview
/// can load via `convertFileSrc`. Handles relative paths (against the current
/// note, then the vault root) and bare filenames (searched across the vault).
#[tauri::command]
pub fn resolve_asset(
    state: State<AppState>,
    current_note: Option<String>,
    target: String,
) -> Result<Option<String>, String> {
    with_vault(&state, |ctx| {
        let target = target.trim();
        if target.starts_with("http://")
            || target.starts_with("https://")
            || target.starts_with("data:")
        {
            return Ok(Some(target.to_string()));
        }
        // Drop any "|width" suffix used by embeds.
        let target = target.split('|').next().unwrap_or(target).trim();

        let mut candidates: Vec<std::path::PathBuf> = Vec::new();
        if target.contains('/') || target.contains('\\') {
            if let Some(note) = &current_note {
                if let Some(dir) = std::path::Path::new(note).parent() {
                    candidates.push(ctx.root.join(dir).join(target));
                }
            }
            candidates.push(ctx.root.join(target));
        }
        for c in candidates {
            if c.is_file() {
                return Ok(Some(c.to_string_lossy().to_string()));
            }
        }

        // Fall back to a filename search across the vault (Obsidian-style embeds).
        let fname = std::path::Path::new(target)
            .file_name()
            .map(|s| s.to_string_lossy().to_lowercase());
        if let Some(fname) = fname {
            for entry in walkdir::WalkDir::new(&ctx.root)
                .into_iter()
                .filter_map(|e| e.ok())
            {
                if entry.file_type().is_file()
                    && entry.file_name().to_string_lossy().to_lowercase() == fname
                {
                    return Ok(Some(entry.path().to_string_lossy().to_string()));
                }
            }
        }
        Ok(None)
    })
}

/// Read a per-vault metadata file from `<vault>/.onyx/<name>` (e.g. workspace,
/// bookmarks). Returns None if absent.
#[tauri::command]
pub fn read_vault_meta(state: State<AppState>, name: String) -> Result<Option<String>, String> {
    with_vault(&state, |ctx| {
        let safe = name.replace(['/', '\\'], "_");
        Ok(std::fs::read_to_string(ctx.root.join(".onyx").join(safe)).ok())
    })
}

/// Write a per-vault metadata file under `<vault>/.onyx/`.
#[tauri::command]
pub fn write_vault_meta(state: State<AppState>, name: String, content: String) -> Result<(), String> {
    with_vault(&state, |ctx| {
        let dir = ctx.root.join(".onyx");
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let safe = name.replace(['/', '\\'], "_");
        std::fs::write(dir.join(safe), content).map_err(|e| e.to_string())
    })
}

/// Save pasted/dropped binary data into the vault's `attachments/` folder.
/// Returns the attachment's filename (for an `![[name]]` embed).
#[tauri::command]
pub fn save_attachment(
    state: State<AppState>,
    name: String,
    data: Vec<u8>,
    folder: Option<String>,
) -> Result<String, String> {
    with_vault(&state, |ctx| {
        let folder = folder.filter(|f| !f.trim().is_empty()).unwrap_or_else(|| "attachments".into());
        let dir = ctx.root.join(folder.trim_matches('/'));
        std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
        let ext = std::path::Path::new(&name)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png");
        let fname = format!("pasted-{}.{ext}", now_secs());
        std::fs::write(dir.join(&fname), &data).map_err(|e| e.to_string())?;
        Ok(fname)
    })
}

/// Create a folder (and any missing parents) under the vault.
#[tauri::command]
pub fn create_folder(state: State<AppState>, path: String) -> Result<String, String> {
    with_vault(&state, |ctx| {
        let rel = path.trim().trim_start_matches('/').trim_end_matches('/').to_string();
        if rel.is_empty() {
            return Err("Folder name is empty".into());
        }
        let abs = vault::resolve(&ctx.root, &rel)?;
        std::fs::create_dir_all(&abs).map_err(|e| e.to_string())?;
        Ok(rel)
    })
}

/// Rename (or move) a note, rewriting every `[[wikilink]]`/`![[embed]]` that
/// points to it across the vault. Returns the new relative path.
#[tauri::command]
pub fn rename_path(state: State<AppState>, old: String, new: String) -> Result<String, String> {
    let mut guard = state.vault.lock().unwrap();
    let ctx = guard.as_mut().ok_or("No vault is open")?;
    let root = ctx.root.clone();

    let old_rel = old.trim().trim_matches('/').to_string();
    if old_rel.is_empty() {
        return Err("Nothing to rename".into());
    }
    let mut new_rel = new.trim().trim_matches('/').to_string();
    if new_rel.is_empty() {
        return Err("New name is empty".into());
    }
    if old_rel.to_lowercase().ends_with(".md") && !new_rel.to_lowercase().ends_with(".md") {
        new_rel.push_str(".md");
    }
    if new_rel == old_rel {
        return Ok(old_rel);
    }

    let old_abs = vault::resolve(&root, &old_rel)?;
    let new_abs = vault::resolve(&root, &new_rel)?;
    if !old_abs.exists() {
        return Err("Source no longer exists".into());
    }
    if new_abs.exists() {
        return Err(format!("“{new_rel}” already exists"));
    }
    if let Some(parent) = new_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&old_abs, &new_abs).map_err(|e| e.to_string())?;

    // Rewrite links across the vault when the note's name (stem) changes.
    let old_name = index::note_name(&old_rel);
    let new_name = index::note_name(&new_rel);
    if old_name != new_name {
        for entry in walkdir::WalkDir::new(&root)
            .into_iter()
            .filter_map(|e| e.ok())
        {
            let p = entry.path();
            if p.extension().and_then(|e| e.to_str()) != Some("md") {
                continue;
            }
            if p.components().any(|c| c.as_os_str() == ".onyx") {
                continue;
            }
            if let Ok(content) = std::fs::read_to_string(p) {
                let (out, n) = index::rewrite_wikilinks(&content, &old_name, &new_name);
                if n > 0 {
                    let _ = std::fs::write(p, out);
                }
            }
        }
    }

    index::reindex_all(&mut ctx.conn, &root).map_err(|e| e.to_string())?;
    Ok(new_rel)
}

/// Move a note or folder into `dest_dir` (vault-relative; "" = vault root).
/// Returns the new relative path. Wikilinks resolve by name, so moving a note
/// between folders does not break `[[links]]` to it.
#[tauri::command]
pub fn move_path(
    state: State<AppState>,
    src: String,
    dest_dir: String,
) -> Result<String, String> {
    let mut guard = state.vault.lock().unwrap();
    let ctx = guard.as_mut().ok_or("No vault is open")?;

    let src = src.trim().trim_matches('/').to_string();
    if src.is_empty() {
        return Err("Nothing to move".into());
    }
    let dest_dir = dest_dir.trim().trim_matches('/').to_string();

    let file_name = std::path::Path::new(&src)
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .ok_or("Invalid source path")?;

    let new_rel = if dest_dir.is_empty() {
        file_name
    } else {
        format!("{dest_dir}/{file_name}")
    };

    if new_rel == src {
        return Ok(src); // already there
    }
    // Prevent moving a folder into itself or a descendant.
    if dest_dir == src || dest_dir.starts_with(&format!("{src}/")) {
        return Err("Cannot move a folder into itself".into());
    }

    let src_abs = vault::resolve(&ctx.root, &src)?;
    let dest_abs = vault::resolve(&ctx.root, &new_rel)?;
    if !src_abs.exists() {
        return Err("Source no longer exists".into());
    }
    if dest_abs.exists() {
        return Err(format!("“{new_rel}” already exists"));
    }
    if let Some(parent) = dest_abs.parent() {
        std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
    }
    std::fs::rename(&src_abs, &dest_abs).map_err(|e| e.to_string())?;

    let root = ctx.root.clone();
    index::reindex_all(&mut ctx.conn, &root).map_err(|e| e.to_string())?;
    Ok(new_rel)
}

#[tauri::command]
pub fn delete_note(state: State<AppState>, path: String) -> Result<(), String> {
    with_vault(&state, |ctx| {
        let abs = vault::resolve(&ctx.root, &path)?;
        std::fs::remove_file(&abs).map_err(|e| e.to_string())?;
        let _ = vector::delete_note(&ctx.conn, &path);
        index::remove_note(&ctx.conn, &path).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn get_backlinks(state: State<AppState>, name: String) -> Result<Vec<Backlink>, String> {
    with_vault(&state, |ctx| {
        let mut links = index::backlinks(&ctx.conn, &name).map_err(|e| e.to_string())?;
        // Fill snippets from the actual files.
        for bl in &mut links {
            if let Ok(abs) = vault::resolve(&ctx.root, &bl.path) {
                if let Ok(content) = std::fs::read_to_string(&abs) {
                    bl.snippet = content
                        .lines()
                        .map(|l| l.trim())
                        .find(|l| !l.is_empty() && !l.starts_with('#'))
                        .unwrap_or("")
                        .chars()
                        .take(160)
                        .collect();
                }
            }
        }
        Ok(links)
    })
}

#[tauri::command]
pub fn search_notes(state: State<AppState>, query: String) -> Result<Vec<SearchResult>, String> {
    with_vault(&state, |ctx| {
        index::search(&ctx.conn, &query).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn get_note_names(state: State<AppState>) -> Result<Vec<String>, String> {
    with_vault(&state, |ctx| {
        index::all_note_names(&ctx.conn).map_err(|e| e.to_string())
    })
}

#[tauri::command]
pub fn get_graph(state: State<AppState>) -> Result<GraphData, String> {
    with_vault(&state, |ctx| index::graph(&ctx.conn).map_err(|e| e.to_string()))
}

/// All notes as queryable Dataview "pages" (metadata, fields, tasks, links).
#[tauri::command]
pub fn get_pages(state: State<AppState>) -> Result<Vec<index::Page>, String> {
    with_vault(&state, |ctx| index::pages(&ctx.conn, &ctx.root).map_err(|e| e.to_string()))
}

/// Toggle the checkbox of a task at `line` (0-based) in a note.
#[tauri::command]
pub fn toggle_task(state: State<AppState>, path: String, line: usize) -> Result<(), String> {
    with_vault(&state, |ctx| {
        let abs = vault::resolve(&ctx.root, &path)?;
        let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
        let mut lines: Vec<String> = content.split('\n').map(String::from).collect();
        if line >= lines.len() {
            return Err("Task line out of range".into());
        }
        let l = &lines[line];
        lines[line] = if l.contains("[ ]") {
            l.replacen("[ ]", "[x]", 1)
        } else if l.contains("[x]") {
            l.replacen("[x]", "[ ]", 1)
        } else if l.contains("[X]") {
            l.replacen("[X]", "[ ]", 1)
        } else {
            l.clone()
        };
        let new_content = lines.join("\n");
        std::fs::write(&abs, &new_content).map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, &path, &new_content, now_secs()).map_err(|e| e.to_string())
    })
}

/// Full reindex (used after the watcher reports external changes).
#[tauri::command]
pub fn reindex(state: State<AppState>) -> Result<usize, String> {
    let mut guard = state.vault.lock().unwrap();
    let ctx = guard.as_mut().ok_or("No vault is open")?;
    let root = ctx.root.clone();
    index::reindex_all(&mut ctx.conn, &root).map_err(|e| e.to_string())
}

/// Resolve a wikilink target name (file stem or alias) to a note path, if any.
#[tauri::command]
pub fn resolve_link(state: State<AppState>, name: String) -> Result<Option<String>, String> {
    with_vault(&state, |ctx| {
        index::resolve_name(&ctx.conn, &name).map_err(|e| e.to_string())
    })
}

/// All tags with note counts (most-used first).
#[tauri::command]
pub fn get_tags(state: State<AppState>) -> Result<Vec<(String, i64)>, String> {
    with_vault(&state, |ctx| index::tags(&ctx.conn).map_err(|e| e.to_string()))
}

/// Note paths carrying a given tag.
#[tauri::command]
pub fn get_notes_by_tag(state: State<AppState>, tag: String) -> Result<Vec<String>, String> {
    with_vault(&state, |ctx| {
        index::notes_by_tag(&ctx.conn, &tag).map_err(|e| e.to_string())
    })
}

/// Notes that mention `name` in their text but don't link to it (unlinked mentions).
#[tauri::command]
pub fn get_unlinked_mentions(
    state: State<AppState>,
    name: String,
) -> Result<Vec<SearchResult>, String> {
    with_vault(&state, |ctx| {
        let hits = index::search(&ctx.conn, &name).map_err(|e| e.to_string())?;
        let linked: HashSet<String> = index::backlinks(&ctx.conn, &name)
            .map_err(|e| e.to_string())?
            .into_iter()
            .map(|b| b.path)
            .collect();
        let lname = name.to_lowercase();
        Ok(hits
            .into_iter()
            .filter(|r| {
                index::note_name(&r.path).to_lowercase() != lname && !linked.contains(&r.path)
            })
            .take(30)
            .collect())
    })
}

// ---------------------------------------------------------------------------
// AI (LM Studio) commands
// ---------------------------------------------------------------------------

#[tauri::command]
pub fn ai_get_config(app: AppHandle) -> AiConfig {
    ai::load_config(&app)
}

#[tauri::command]
pub fn ai_set_config(app: AppHandle, config: AiConfig) {
    ai::save_config(&app, &config);
}

/// List models available at a base URL (used by Settings / "test connection").
#[tauri::command]
pub async fn ai_list_models(base_url: String) -> Result<Vec<String>, String> {
    ai::list_models(&base_url).await
}

/// Start a streaming chat completion. Tokens arrive via `ai-chat:*` events.
#[tauri::command]
pub fn ai_chat(app: AppHandle, messages: Vec<ChatMessage>, request_id: String) {
    let cfg = ai::load_config(&app);
    tauri::async_runtime::spawn(async move {
        ai::chat_stream(app, cfg, messages, request_id).await;
    });
}

/// Number of embedded chunks stored (0 if the vault hasn't been indexed).
#[tauri::command]
pub fn ai_index_status(state: State<AppState>) -> Result<i64, String> {
    with_vault(&state, |ctx| Ok(vector::chunk_count(&ctx.conn)))
}

/// Embed every note in the vault and store vectors. Progress via `ai-index:*`.
#[tauri::command]
pub async fn ai_index_vault(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<usize, String> {
    let cfg = ai::load_config(&app);
    if cfg.embed_model.is_empty() {
        return Err("No embedding model configured (set one in Settings).".into());
    }

    // Snapshot the vault root + note paths, then release the lock.
    let (root, paths) = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        let mut stmt = ctx
            .conn
            .prepare("SELECT path FROM notes ORDER BY path")
            .map_err(|e| e.to_string())?;
        let paths: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        (ctx.root.clone(), paths)
    };

    // Read + chunk every note (no lock, no network).
    let mut items: Vec<(String, i64, String)> = Vec::new();
    for p in &paths {
        let abs = vault::resolve(&root, p)?;
        let content = std::fs::read_to_string(&abs).unwrap_or_default();
        for (idx, text) in index::chunk_content(&content, 1000) {
            items.push((p.clone(), idx, text));
        }
    }
    let total = items.len();
    if total == 0 {
        let _ = app.emit("ai-index:done", serde_json::json!({ "chunks": 0 }));
        return Ok(0);
    }

    // Embed in batches (network; no lock held across await).
    let mut embedded: Vec<(String, i64, String, Vec<f32>)> = Vec::with_capacity(total);
    let mut done = 0usize;
    for batch in items.chunks(32) {
        let inputs: Vec<String> = batch
            .iter()
            .map(|(p, _, t)| format!("{}\n\n{}", index::note_name(p), t))
            .collect();
        let vecs = match ai::embed(&cfg, inputs).await {
            Ok(v) => v,
            Err(e) => {
                let _ = app.emit("ai-index:error", serde_json::json!({ "error": e }));
                return Err(e);
            }
        };
        for ((p, idx, t), v) in batch.iter().zip(vecs.into_iter()) {
            embedded.push((p.clone(), *idx, t.clone(), v));
        }
        done += batch.len();
        let _ = app.emit(
            "ai-index:progress",
            serde_json::json!({ "done": done, "total": total }),
        );
    }

    // Store all vectors under the lock.
    let dim = embedded.first().map(|e| e.3.len()).unwrap_or(0);
    {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        vector::reset_table(&ctx.conn, dim).map_err(|e| e.to_string())?;
        for (p, idx, t, v) in &embedded {
            vector::insert_chunk(&ctx.conn, p, *idx, t, v).map_err(|e| e.to_string())?;
        }
    }

    let _ = app.emit("ai-index:done", serde_json::json!({ "chunks": total }));
    Ok(total)
}

/// Embed a query and return the k most similar note chunks.
#[tauri::command]
pub async fn ai_semantic_search(
    app: AppHandle,
    state: State<'_, AppState>,
    query: String,
    k: usize,
) -> Result<Vec<SemanticHit>, String> {
    let cfg = ai::load_config(&app);
    let emb = ai::embed(&cfg, vec![query]).await?;
    let q = emb.into_iter().next().ok_or("No embedding returned")?;
    let guard = state.vault.lock().unwrap();
    let ctx = guard.as_ref().ok_or("No vault is open")?;
    vector::search(&ctx.conn, &q, k).map_err(|e| e.to_string())
}

// ---------------------------------------------------------------------------
// Phase 3 — AI features (suggestions are returned, never auto-applied)
// ---------------------------------------------------------------------------

/// Create a note pre-filled with content, using a unique filename if needed.
#[tauri::command]
pub fn create_note_with_content(
    state: State<AppState>,
    path: String,
    content: String,
) -> Result<String, String> {
    with_vault(&state, |ctx| {
        let mut base = path.trim().trim_start_matches('/').to_string();
        if base.to_lowercase().ends_with(".md") {
            base.truncate(base.len() - 3);
        }
        // Sanitize characters awkward in filenames.
        let base = base.replace(['/', '\\'], "-");
        let mut rel = format!("{base}.md");
        let mut n = 2;
        while vault::resolve(&ctx.root, &rel)?.exists() {
            rel = format!("{base} {n}.md");
            n += 1;
        }
        let abs = vault::resolve(&ctx.root, &rel)?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&abs, &content).map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, &rel, &content, now_secs()).map_err(|e| e.to_string())?;
        Ok(rel)
    })
}

/// Suggest topical tags for a note (reusing existing vocabulary where possible).
#[tauri::command]
pub async fn ai_suggest_tags(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<String>, String> {
    let cfg = ai::load_config(&app);
    let (root, vocab) = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        let mut stmt = ctx
            .conn
            .prepare("SELECT DISTINCT tag FROM tags ORDER BY tag")
            .map_err(|e| e.to_string())?;
        let vocab: Vec<String> = stmt
            .query_map([], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        (ctx.root.clone(), vocab)
    };
    let abs = vault::resolve(&root, &path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let existing = index::extract_tags(&content);

    let messages = vec![
        msg(
            "system",
            "You suggest concise topical tags for a note. Respond ONLY with a JSON array of \
             lowercase tag strings, no '#' prefix, no spaces (use hyphens)."
                .to_string(),
        ),
        msg(
            "user",
            format!(
                "Existing tag vocabulary (reuse when relevant): {}\n\nTags already on this note: {}\n\n\
                 Note content:\n{}\n\nReturn 3-6 tags as a JSON array.",
                vocab.join(", "),
                existing.join(", "),
                truncate(&content, 4000)
            ),
        ),
    ];
    let out = ai::chat_complete(&cfg, messages).await?;
    let arr = json_array(&out).ok_or("Could not parse tags from model output")?;
    let mut tags: Vec<String> = arr
        .into_iter()
        .filter_map(|v| {
            v.as_str()
                .map(|s| s.trim().trim_start_matches('#').to_lowercase())
        })
        .filter(|s| !s.is_empty() && !s.contains(' '))
        .collect();
    let existing_lc: HashSet<String> = existing.iter().map(|t| t.to_lowercase()).collect();
    tags.retain(|t| !existing_lc.contains(t));
    tags.sort();
    tags.dedup();
    Ok(tags)
}

/// Suggest cross-links from the current note to semantically related notes.
#[tauri::command]
pub async fn ai_suggest_links(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<Vec<LinkSuggestion>, String> {
    let cfg = ai::load_config(&app);
    let root = with_vault(&state, |ctx| Ok(ctx.root.clone()))?;
    let abs = vault::resolve(&root, &path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let self_name = index::note_name(&path).to_lowercase();
    let already: HashSet<String> = index::extract_wikilinks(&content)
        .into_iter()
        .map(|s| s.to_lowercase())
        .collect();

    let emb = ai::embed(&cfg, vec![truncate(&content, 4000)]).await?;
    let q = emb.into_iter().next().ok_or("No embedding returned")?;
    let hits = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        vector::search(&ctx.conn, &q, 14).map_err(|e| e.to_string())?
    };

    // Unique candidates, excluding self and already-linked notes.
    let mut candidates: Vec<(String, String, String)> = Vec::new();
    let mut seen = HashSet::new();
    for h in hits {
        let title = index::note_name(&h.path);
        let title_lc = title.to_lowercase();
        if title_lc == self_name || already.contains(&title_lc) {
            continue;
        }
        if !seen.insert(h.path.clone()) {
            continue;
        }
        candidates.push((h.path, title, truncate(&h.text, 200)));
        if candidates.len() >= 8 {
            break;
        }
    }
    if candidates.is_empty() {
        return Ok(vec![]);
    }

    let listing = candidates
        .iter()
        .enumerate()
        .map(|(i, (_, t, s))| format!("{}. {} — {}", i + 1, t, s))
        .collect::<Vec<_>>()
        .join("\n");
    let messages = vec![
        msg(
            "system",
            "You suggest wiki-style links between notes. Respond ONLY with a JSON array of objects \
             {\"index\": <number from the list>, \"reason\": <short reason>} for notes genuinely \
             related to the current note. Omit weak matches."
                .to_string(),
        ),
        msg(
            "user",
            format!(
                "Current note:\n{}\n\nCandidate notes:\n{}\n\nWhich candidates should be linked? \
                 JSON array only.",
                truncate(&content, 3000),
                listing
            ),
        ),
    ];
    let out = ai::chat_complete(&cfg, messages).await?;
    let arr = json_array(&out).ok_or("Could not parse link suggestions")?;
    let mut suggestions = Vec::new();
    for v in arr {
        if let Some(idx) = v.get("index").and_then(|x| x.as_u64()) {
            let i = idx as usize;
            if i >= 1 && i <= candidates.len() {
                let (p, t, _) = &candidates[i - 1];
                let reason = v
                    .get("reason")
                    .and_then(|x| x.as_str())
                    .unwrap_or("")
                    .to_string();
                suggestions.push(LinkSuggestion {
                    name: t.clone(),
                    path: p.clone(),
                    reason,
                });
            }
        }
    }
    Ok(suggestions)
}

/// Synthesize a set of notes (by tag, folder, or whole vault) into a brief.
#[tauri::command]
pub async fn ai_synthesize(
    app: AppHandle,
    state: State<'_, AppState>,
    scope_kind: String,
    scope_value: String,
) -> Result<AiDocument, String> {
    synthesize_doc(&app, &state, &scope_kind, &scope_value).await
}

async fn synthesize_doc(
    app: &AppHandle,
    state: &State<'_, AppState>,
    scope_kind: &str,
    scope_value: &str,
) -> Result<AiDocument, String> {
    let cfg = ai::load_config(app);
    let (root, notes) = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        let paths: Vec<String> = match scope_kind {
            "tag" => {
                let tag = scope_value.trim_start_matches('#').to_string();
                let mut s = ctx
                    .conn
                    .prepare(
                        "SELECT n.path FROM tags t JOIN notes n ON n.id = t.note_id \
                         WHERE t.tag = ?1 COLLATE NOCASE ORDER BY n.path",
                    )
                    .map_err(|e| e.to_string())?;
                let v: Vec<String> = s
                    .query_map([tag], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                v
            }
            "folder" => {
                let like = format!("{}/%", scope_value.trim_matches('/'));
                let mut s = ctx
                    .conn
                    .prepare("SELECT path FROM notes WHERE path LIKE ?1 ORDER BY path")
                    .map_err(|e| e.to_string())?;
                let v: Vec<String> = s
                    .query_map([like], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                v
            }
            _ => {
                let mut s = ctx
                    .conn
                    .prepare("SELECT path FROM notes ORDER BY path")
                    .map_err(|e| e.to_string())?;
                let v: Vec<String> = s
                    .query_map([], |r| r.get::<_, String>(0))
                    .map_err(|e| e.to_string())?
                    .filter_map(|r| r.ok())
                    .collect();
                v
            }
        };
        (ctx.root.clone(), paths)
    };
    if notes.is_empty() {
        return Err("No notes match that scope.".into());
    }

    let mut corpus = String::new();
    let used = notes.len().min(30);
    for p in notes.iter().take(30) {
        let abs = vault::resolve(&root, p)?;
        if let Ok(c) = std::fs::read_to_string(&abs) {
            corpus.push_str(&format!("\n\n## {}\n{}", index::note_name(p), truncate(&c, 1200)));
        }
    }

    let messages = vec![
        msg(
            "system",
            "You are a research analyst. Synthesize the provided notes into a concise markdown \
             brief with sections: Overview, Key Themes, Connections, Contradictions/Tensions, \
             Open Questions. Reference notes with [[Note Title]] wikilinks where relevant. Do not \
             invent facts beyond the notes. Directly under each `##` heading, add an HTML comment \
             of the form `<!--ai\n<one sentence on what this section should contain>\n-->` so the \
             page can be regenerated section-by-section later."
                .to_string(),
        ),
        msg("user", format!("Notes to synthesize:{corpus}")),
    ];
    let body = ai::chat_complete(&cfg, messages).await?;
    let label = if scope_value.is_empty() {
        "vault".to_string()
    } else {
        scope_value.to_string()
    };
    let title = format!("Synthesis - {label}");
    let fm = format!(
        "---\nonyx_generated: synthesis\nonyx_scope_kind: {}\nonyx_scope_value: {}\n---\n\n",
        yaml_quote(scope_kind),
        yaml_quote(scope_value),
    );
    let header = format!("# {title}\n\n*Synthesized from {used} note(s).*\n\n");
    Ok(AiDocument {
        title,
        content: fm + &header + &body,
    })
}

/// Generate a Wikipedia-style subject page grounded in related notes, with citations.
#[tauri::command]
pub async fn ai_subject_page(
    app: AppHandle,
    state: State<'_, AppState>,
    subject: String,
) -> Result<AiDocument, String> {
    subject_doc(&app, &state, &subject).await
}

async fn subject_doc(
    app: &AppHandle,
    state: &State<'_, AppState>,
    subject: &str,
) -> Result<AiDocument, String> {
    let cfg = ai::load_config(app);
    let emb = ai::embed(&cfg, vec![subject.to_string()]).await?;
    let q = emb.into_iter().next().ok_or("No embedding returned")?;

    let (root, hits, tagged) = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        let hits = vector::search(&ctx.conn, &q, 14).map_err(|e| e.to_string())?;
        let tag = subject.trim_start_matches('#').to_string();
        let mut s = ctx
            .conn
            .prepare(
                "SELECT n.path FROM tags t JOIN notes n ON n.id = t.note_id \
                 WHERE t.tag = ?1 COLLATE NOCASE",
            )
            .map_err(|e| e.to_string())?;
        let tagged: Vec<String> = s
            .query_map([tag], |r| r.get::<_, String>(0))
            .map_err(|e| e.to_string())?
            .filter_map(|r| r.ok())
            .collect();
        (ctx.root.clone(), hits, tagged)
    };

    let mut paths: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for h in &hits {
        if seen.insert(h.path.clone()) {
            paths.push(h.path.clone());
        }
    }
    for p in tagged {
        if seen.insert(p.clone()) {
            paths.push(p);
        }
    }
    if paths.is_empty() {
        return Err("No related notes found. Index the vault in Settings first.".into());
    }

    let mut corpus = String::new();
    for p in paths.iter().take(16) {
        let abs = vault::resolve(&root, p)?;
        if let Ok(c) = std::fs::read_to_string(&abs) {
            corpus.push_str(&format!("\n\n### {}\n{}", index::note_name(p), truncate(&c, 1000)));
        }
    }

    let messages = vec![
        msg(
            "system",
            "You write encyclopedic, Wikipedia-style subject pages STRICTLY from the supplied \
             notes. Use markdown headings. Cite supporting notes inline as [[Note Title]]. Do not \
             invent facts not present in the notes. End with a 'Sources' section listing the \
             [[Note Title]] links you used. Directly under each `##` heading, add an HTML comment of \
             the form `<!--ai\n<one sentence on what this section should contain>\n-->` so the page \
             can be regenerated section-by-section later."
                .to_string(),
        ),
        msg("user", format!("Subject: {subject}\n\nSource notes:{corpus}")),
    ];
    let content = ai::chat_complete(&cfg, messages).await?;
    let fm = format!(
        "---\nonyx_generated: subject\nonyx_subject: {}\n---\n\n",
        yaml_quote(subject),
    );
    Ok(AiDocument {
        title: subject.to_string(),
        content: fm + &content,
    })
}

/// Re-run the generator that produced an AI page, pulling fresh information from
/// the vault. Reads the page's `onyx_generated` frontmatter for its parameters.
#[tauri::command]
pub async fn ai_regenerate(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<AiDocument, String> {
    let content = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        let abs = vault::resolve(&ctx.root, &path)?;
        std::fs::read_to_string(&abs).map_err(|e| e.to_string())?
    };
    let kind = frontmatter_value(&content, "onyx_generated")
        .ok_or("This page wasn't generated by Onyx, so there's nothing to regenerate.")?;
    match kind.as_str() {
        "synthesis" => {
            let sk = frontmatter_value(&content, "onyx_scope_kind").unwrap_or_else(|| "all".into());
            let sv = frontmatter_value(&content, "onyx_scope_value").unwrap_or_default();
            synthesize_doc(&app, &state, &sk, &sv).await
        }
        "subject" => {
            let subj = frontmatter_value(&content, "onyx_subject")
                .ok_or("This subject page is missing its subject in frontmatter.")?;
            subject_doc(&app, &state, &subj).await
        }
        other => Err(format!("Unknown generated page kind: {other}")),
    }
}

const COMPOSE_SYSTEM: &str =
    "You are composing ONE section of an existing markdown document. Output ONLY the markdown body \
     for this section — do NOT repeat the section heading, and do NOT include any <!--ai ... --> \
     comment. Follow the section's instruction exactly, including any required sub-structure \
     (sub-headings, lists, tables). Where relevant, cite vault notes as [[Note Title]]. Use the \
     supplied material and related notes; do not invent facts beyond them. Keep formatting clean.";

/// Retrieve related vault notes for grounding a section. Best-effort: returns an
/// empty string if there's no embed model or no existing vector index.
async fn gather_grounding(
    state: &State<'_, AppState>,
    cfg: &AiConfig,
    root: &std::path::Path,
    query: &str,
) -> String {
    if cfg.embed_model.is_empty() {
        return String::new();
    }
    let emb = match ai::embed(cfg, vec![query.to_string()]).await {
        Ok(v) => v,
        Err(_) => return String::new(),
    };
    let q = match emb.into_iter().next() {
        Some(q) => q,
        None => return String::new(),
    };
    let hits = {
        let guard = state.vault.lock().unwrap();
        let ctx = match guard.as_ref() {
            Some(c) => c,
            None => return String::new(),
        };
        match vector::search(&ctx.conn, &q, 8) {
            Ok(h) => h,
            Err(_) => return String::new(),
        }
    };
    let mut corpus = String::new();
    let mut seen = HashSet::new();
    for h in hits {
        if !seen.insert(h.path.clone()) {
            continue;
        }
        if let Ok(abs) = vault::resolve(root, &h.path) {
            if let Ok(c) = std::fs::read_to_string(&abs) {
                corpus.push_str(&format!("\n\n### {}\n{}", index::note_name(&h.path), truncate(&c, 800)));
            }
        }
    }
    corpus
}

/// Strip a leading heading line from model output if it just repeats the
/// section's own heading (models sometimes echo it back).
fn clean_section_body(raw: &str, title: &str) -> String {
    let nb = raw.trim();
    let mut iter = nb.lines();
    if let Some(first) = iter.next() {
        let f = first.trim_start();
        if f.starts_with('#') && f.trim_start_matches('#').trim().eq_ignore_ascii_case(title) {
            return iter.collect::<Vec<_>>().join("\n").trim_start().to_string();
        }
    }
    nb.to_string()
}

/// Hierarchical Context Metadata (HCM): walk the note's heading sections and
/// regenerate the body of each section that carries an `<!--ai … -->`
/// instruction, inheriting parent instructions and grounding in related notes.
/// Sections without an instruction are preserved byte-for-byte.
#[tauri::command]
pub async fn ai_compose_sections(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<AiDocument, String> {
    let cfg = ai::load_config(&app);
    let (root, content) = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        let abs = vault::resolve(&ctx.root, &path)?;
        (ctx.root.clone(), std::fs::read_to_string(&abs).map_err(|e| e.to_string())?)
    };

    let sections = index::parse_sections(&content);
    let lines: Vec<&str> = content.split('\n').collect();
    let targets: Vec<usize> = sections
        .iter()
        .enumerate()
        .filter(|(_, s)| s.instruction.is_some())
        .map(|(i, _)| i)
        .collect();
    if targets.is_empty() {
        return Err("This page has no AI context (<!--ai … -->) blocks to compose.".into());
    }
    let total = targets.len();

    let outline = sections
        .iter()
        .map(|s| format!("{} {}", "#".repeat(s.level), s.title))
        .collect::<Vec<_>>()
        .join("\n");

    let mut new_bodies: Vec<Option<String>> = vec![None; sections.len()];
    let mut done = 0usize;
    for &i in &targets {
        let sec = &sections[i];
        let instruction = sec.instruction.clone().unwrap_or_default();
        let inherited = index::ancestors(&sections, i);
        let material = lines[sec.body_start..sec.body_end].join("\n");
        let corpus = gather_grounding(&state, &cfg, &root, &format!("{}\n{}", sec.title, instruction)).await;

        let mut user = format!("Document outline:\n{outline}\n\n");
        if !inherited.is_empty() {
            user.push_str(&format!(
                "Inherited context from parent sections:\n{}\n\n",
                inherited.join("\n")
            ));
        }
        user.push_str(&format!(
            "Section to compose: {} {}\n\nInstruction:\n{}\n\n",
            "#".repeat(sec.level),
            sec.title,
            instruction
        ));
        if !corpus.is_empty() {
            user.push_str(&format!("Related notes from the vault:{corpus}\n\n"));
        }
        user.push_str(&format!(
            "Current material under this section (transform per the instruction):\n{}",
            truncate(&material, 4000)
        ));

        let messages = vec![msg("system", COMPOSE_SYSTEM.to_string()), msg("user", user)];
        let raw = ai::chat_complete(&cfg, messages).await?;
        new_bodies[i] = Some(clean_section_body(&raw, &sec.title));
        done += 1;
        let _ = app.emit("ai-compose:progress", serde_json::json!({ "done": done, "total": total }));
    }

    // Reconstruct: preamble + each section's (heading + HCM) verbatim, then the
    // regenerated body where present, else the original body verbatim.
    let first = sections.first().map(|s| s.heading_line).unwrap_or(lines.len());
    let mut out: Vec<String> = lines[..first].iter().map(|s| s.to_string()).collect();
    for (i, sec) in sections.iter().enumerate() {
        for l in &lines[sec.heading_line..sec.body_start] {
            out.push(l.to_string());
        }
        match &new_bodies[i] {
            Some(nb) => {
                for l in nb.split('\n') {
                    out.push(l.to_string());
                }
                out.push(String::new()); // one blank line before the next heading
            }
            None => {
                for l in &lines[sec.body_start..sec.body_end] {
                    out.push(l.to_string());
                }
            }
        }
    }

    let _ = app.emit("ai-compose:done", serde_json::json!({ "sections": total }));
    Ok(AiDocument {
        title: index::note_name(&path),
        content: out.join("\n"),
    })
}

/// Incrementally (re)embed a single note's chunks, replacing its previous
/// vectors. No-ops unless a vector index already exists and an embed model is
/// configured — so it keeps an existing index fresh without ever starting one.
#[tauri::command]
pub async fn ai_index_note(
    app: AppHandle,
    state: State<'_, AppState>,
    path: String,
) -> Result<bool, String> {
    let cfg = ai::load_config(&app);
    if cfg.embed_model.is_empty() {
        return Ok(false);
    }
    let (root, has_index) = {
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        (ctx.root.clone(), vector::chunk_count(&ctx.conn) > 0)
    };
    if !has_index {
        return Ok(false);
    }

    // Read + chunk + embed without holding the lock across the network call.
    let abs = vault::resolve(&root, &path)?;
    let content = std::fs::read_to_string(&abs).unwrap_or_default();
    let chunks = index::chunk_content(&content, 1000);
    let mut vecs: Vec<(i64, String, Vec<f32>)> = Vec::new();
    if !chunks.is_empty() {
        let inputs: Vec<String> = chunks
            .iter()
            .map(|(_, t)| format!("{}\n\n{}", index::note_name(&path), t))
            .collect();
        let embedded = ai::embed(&cfg, inputs).await?;
        for ((idx, t), v) in chunks.into_iter().zip(embedded.into_iter()) {
            vecs.push((idx, t, v));
        }
    }

    let dim = vecs.first().map(|x| x.2.len());
    let guard = state.vault.lock().unwrap();
    let ctx = guard.as_ref().ok_or("No vault is open")?;
    if let Some(d) = dim {
        vector::ensure_table(&ctx.conn, d).map_err(|e| e.to_string())?;
    }
    vector::delete_note(&ctx.conn, &path).map_err(|e| e.to_string())?;
    for (idx, t, v) in &vecs {
        vector::insert_chunk(&ctx.conn, &path, *idx, t, v).map_err(|e| e.to_string())?;
    }
    Ok(true)
}

/// RAG chat: retrieve relevant chunks, emit `ai-chat:sources`, then stream the
/// answer via the usual `ai-chat:*` events.
#[tauri::command]
pub async fn ai_rag_chat(
    app: AppHandle,
    state: State<'_, AppState>,
    messages: Vec<ChatMessage>,
    request_id: String,
) -> Result<(), String> {
    let cfg = ai::load_config(&app);
    let query = messages
        .iter()
        .rev()
        .find(|m| m.role == "user")
        .map(|m| m.content.clone())
        .unwrap_or_default();

    let hits = if query.is_empty() {
        vec![]
    } else {
        let emb = ai::embed(&cfg, vec![query.clone()]).await?;
        let q = emb.into_iter().next().ok_or("No embedding returned")?;
        let guard = state.vault.lock().unwrap();
        let ctx = guard.as_ref().ok_or("No vault is open")?;
        vector::search(&ctx.conn, &q, 6).map_err(|e| e.to_string())?
    };

    let mut sources: Vec<String> = Vec::new();
    let mut seen = HashSet::new();
    for h in &hits {
        if seen.insert(h.path.clone()) {
            sources.push(h.path.clone());
        }
    }
    let _ = app.emit(
        "ai-chat:sources",
        serde_json::json!({ "id": request_id, "sources": sources }),
    );

    let context = hits
        .iter()
        .map(|h| format!("[[{}]]:\n{}", index::note_name(&h.path), h.text))
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let system = msg(
        "system",
        format!(
            "You are an assistant answering from the user's personal notes. Use the retrieved \
             context below to answer, and cite sources inline as [[Note Title]]. If the answer is \
             not contained in the notes, say so plainly.\n\nContext:\n{context}"
        ),
    );

    let mut aug = vec![system];
    aug.extend(messages);
    ai::chat_stream(app, cfg, aug, request_id).await;
    Ok(())
}

// ===== Document ingestion =====
//
// Imports an external file (PDF, DOCX, TXT) into the vault as a markdown note.
// PDFs are processed PAGE BY PAGE (when poppler is available) — each page is
// rendered to an image and combined with its extracted text in a single
// vision+text LLM call, then concatenated. This guarantees every page is
// captured and avoids the multi-image attention failure of batching all pages
// into one request. Without poppler (or for DOCX/TXT), the raw text is chunked
// (never truncated) and each chunk is formatted by the LLM. Every pass degrades
// gracefully to raw text if the model is offline or unsupported.

/// System prompt shared by every page/chunk conversion call. Folds in callouts,
/// math fidelity, and auto-linking against existing note titles.
fn conversion_system(vocab: &[String]) -> String {
    let names = vocab
        .iter()
        .take(300)
        .cloned()
        .collect::<Vec<_>>()
        .join(", ");
    let link_rule = if names.is_empty() {
        String::new()
    } else {
        format!(
            "\n- For any term that matches an existing note title, link the FIRST occurrence as a \
             [[wikilink]] (e.g. [[Title]]). Existing note titles: {names}."
        )
    };
    format!(
        "You are a document conversion assistant for Onyx, a markdown note-taking app. Convert the \
         provided document content into clean GitHub-flavored Markdown.\n\
         - Preserve heading hierarchy with ATX headings (##, ###). Do NOT add a top-level # title.\n\
         - Render tables as Markdown tables; preserve lists and nesting; use fenced code blocks for code.\n\
         - Preserve mathematics as LaTeX: inline as $...$ and display as $$...$$.\n\
         - Wrap each key insight, takeaway, definition, or important warning in an Onyx callout, \
         written as a blockquote whose first line is `> [!insight] Short title` followed by `> ` \
         body lines. Use [!warning], [!tip], [!important], [!note], or [!question] when they fit \
         better. Do not over-use callouts.{link_rule}\n\
         - Output ONLY the markdown for this content — no preamble, no explanation."
    )
}

/// One conversion call. With an image it issues a multimodal request; without,
/// it uses the plain chat completion. Returns None on any failure.
async fn convert_part(
    cfg: &AiConfig,
    system: &str,
    user_text: String,
    image_b64: Option<&str>,
) -> Option<String> {
    if let Some(b64) = image_b64 {
        let url = format!("{}/chat/completions", cfg.base_url.trim_end_matches('/'));
        let body = serde_json::json!({
            "model": cfg.chat_model,
            "stream": false,
            "messages": [
                { "role": "system", "content": system },
                { "role": "user", "content": [
                    { "type": "text", "text": user_text },
                    { "type": "image_url", "image_url": { "url": format!("data:image/png;base64,{b64}") } }
                ]}
            ]
        });
        let resp = reqwest::Client::new().post(&url).json(&body).send().await.ok()?;
        if !resp.status().is_success() {
            return None;
        }
        let json: serde_json::Value = resp.json().await.ok()?;
        json["choices"][0]["message"]["content"]
            .as_str()
            .map(|s| s.to_string())
    } else {
        ai::chat_complete(
            cfg,
            vec![msg("system", system.to_string()), msg("user", user_text)],
        )
        .await
        .ok()
    }
}

/// Core ingestion routine (no vault lock held — safe to await across).
async fn build_import_markdown(
    app: &AppHandle,
    cfg: &AiConfig,
    path: &std::path::Path,
    title: &str,
    vocab: &[String],
    use_llm: bool,
) -> String {
    use crate::import;
    let ext = import::ext_of(path);
    let system = conversion_system(vocab);

    // -- PDF page-by-page (vision + per-page text) --
    if use_llm && ext == "pdf" && import::has_poppler() {
        let pages = import::render_pdf_pages(path);
        if !pages.is_empty() {
            let total = pages.len();
            let mut parts: Vec<String> = Vec::with_capacity(total);
            for (idx, b64) in pages.iter().enumerate() {
                let page_no = idx + 1;
                let page_text = import::extract_pdf_page_text(path, page_no).unwrap_or_default();
                let user_text = format!(
                    "This image is page {page_no} of {total} of a document and shows the true \
                     layout. The raw extracted text below is for verbatim accuracy.\n\nRAW TEXT:\n{page_text}"
                );
                let md = convert_part(cfg, &system, user_text, Some(b64)).await;
                parts.push(md.filter(|s| !s.trim().is_empty()).unwrap_or(page_text));
                let _ = app.emit(
                    "import:progress",
                    serde_json::json!({ "page": page_no, "total": total }),
                );
            }
            return format!("# {title}\n\n{}", parts.join("\n\n"));
        }
        // poppler present but rendered nothing — fall through to the text path.
    }

    // -- Text path (DOCX/TXT, PDF without poppler, or use_llm=false) --
    let raw = import::extract_text(path).unwrap_or_default();
    if !use_llm || raw.trim().is_empty() {
        return if raw.trim().is_empty() {
            format!("# {title}\n\n")
        } else {
            format!("# {title}\n\n{raw}")
        };
    }

    let chunks = import::chunk_text(&raw, 8000);
    let total = chunks.len();
    let mut parts: Vec<String> = Vec::with_capacity(total);
    for (idx, chunk) in chunks.iter().enumerate() {
        let md = convert_part(cfg, &system, chunk.clone(), None).await;
        parts.push(md.filter(|s| !s.trim().is_empty()).unwrap_or_else(|| chunk.clone()));
        let _ = app.emit(
            "import:progress",
            serde_json::json!({ "page": idx + 1, "total": total }),
        );
    }
    format!("# {title}\n\n{}", parts.join("\n\n"))
}

/// Snapshot the vault's note titles for auto-linking (lock held briefly).
fn collect_note_names(state: &State<AppState>) -> Result<Vec<String>, String> {
    let guard = state.vault.lock().unwrap();
    let ctx = guard.as_ref().ok_or("No vault is open")?;
    index::all_note_names(&ctx.conn).map_err(|e| e.to_string())
}

/// Write the imported markdown to a uniquely-named note and index it.
fn write_imported_note(
    state: &State<AppState>,
    title: &str,
    markdown: &str,
) -> Result<String, String> {
    with_vault(state, |ctx| {
        let base = title.replace(['/', '\\'], "-");
        let mut rel = format!("{base}.md");
        let mut n = 2;
        while vault::resolve(&ctx.root, &rel)?.exists() {
            rel = format!("{base} {n}.md");
            n += 1;
        }
        let abs = vault::resolve(&ctx.root, &rel)?;
        if let Some(parent) = abs.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        std::fs::write(&abs, markdown).map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, &rel, markdown, now_secs()).map_err(|e| e.to_string())?;
        Ok(rel)
    })
}

/// Import a document by filesystem path (used by the file picker / command palette).
#[tauri::command]
pub async fn import_document(
    app: AppHandle,
    state: State<'_, AppState>,
    file_path: String,
    use_llm: bool,
) -> Result<String, String> {
    let path = std::path::PathBuf::from(&file_path);
    let title = path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported document")
        .to_string();
    let cfg = ai::load_config(&app);
    let vocab = collect_note_names(&state)?;
    let markdown = build_import_markdown(&app, &cfg, &path, &title, &vocab, use_llm).await;
    write_imported_note(&state, &title, &markdown)
}

/// Import a document from raw bytes (used by drag-and-drop, where the browser
/// File API exposes contents but not the filesystem path). Writes the bytes to a
/// temp file and runs the same pipeline.
#[tauri::command]
pub async fn import_document_bytes(
    app: AppHandle,
    state: State<'_, AppState>,
    name: String,
    data: Vec<u8>,
    use_llm: bool,
) -> Result<String, String> {
    let name_path = std::path::Path::new(&name);
    let title = name_path
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("Imported document")
        .to_string();
    let ext = name_path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("bin")
        .to_lowercase();
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let tmp = std::env::temp_dir().join(format!("onyx_dropimport_{stamp}.{ext}"));
    std::fs::write(&tmp, &data).map_err(|e| e.to_string())?;

    let cfg = ai::load_config(&app);
    let vocab = collect_note_names(&state)?;
    let markdown = build_import_markdown(&app, &cfg, &tmp, &title, &vocab, use_llm).await;
    let _ = std::fs::remove_file(&tmp);
    write_imported_note(&state, &title, &markdown)
}
