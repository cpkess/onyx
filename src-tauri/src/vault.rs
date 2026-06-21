//! Vault management: the source of truth is a user-chosen folder of `.md` files.
//! Onyx-specific data lives in `<vault>/.onyx/`.

use notify::event::ModifyKind;
use notify::{EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

use crate::index;

/// Everything tied to the currently-open vault.
pub struct VaultCtx {
    pub root: PathBuf,
    pub conn: Connection,
}

/// Managed application state.
#[derive(Default)]
pub struct AppState {
    pub vault: Mutex<Option<VaultCtx>>,
    pub watcher: Mutex<Option<RecommendedWatcher>>,
}

#[derive(Debug, Serialize)]
pub struct TreeNode {
    pub name: String,
    /// Path relative to the vault root, using `/` separators.
    pub path: String,
    pub is_dir: bool,
    pub children: Vec<TreeNode>,
}

#[derive(Debug, Serialize)]
pub struct VaultInfo {
    pub root: String,
    pub name: String,
    pub tree: Vec<TreeNode>,
    pub note_count: usize,
}

#[derive(Serialize, Deserialize, Default)]
struct OnyxConfig {
    last_vault: Option<String>,
}

fn config_file(app: &AppHandle) -> Option<PathBuf> {
    let dir = app.path().app_config_dir().ok()?;
    let _ = std::fs::create_dir_all(&dir);
    Some(dir.join("onyx.json"))
}

pub fn load_last_vault(app: &AppHandle) -> Option<String> {
    let path = config_file(app)?;
    let data = std::fs::read_to_string(path).ok()?;
    let cfg: OnyxConfig = serde_json::from_str(&data).ok()?;
    cfg.last_vault
}

pub fn save_last_vault(app: &AppHandle, vault: &str) {
    if let Some(path) = config_file(app) {
        let cfg = OnyxConfig {
            last_vault: Some(vault.to_string()),
        };
        if let Ok(data) = serde_json::to_string_pretty(&cfg) {
            let _ = std::fs::write(path, data);
        }
    }
}

fn db_path(root: &Path) -> PathBuf {
    root.join(".onyx").join("onyx.db")
}

/// Recursively build the `.md` file tree, skipping hidden/`.onyx` entries.
pub fn build_tree(root: &Path) -> Vec<TreeNode> {
    build_tree_inner(root, root)
}

fn build_tree_inner(root: &Path, dir: &Path) -> Vec<TreeNode> {
    let mut nodes = Vec::new();
    let entries = match std::fs::read_dir(dir) {
        Ok(e) => e,
        Err(_) => return nodes,
    };
    let mut items: Vec<_> = entries.filter_map(|e| e.ok()).collect();
    items.sort_by_key(|e| e.file_name());

    for entry in items {
        let path = entry.path();
        let name = entry.file_name().to_string_lossy().to_string();
        if name.starts_with('.') {
            continue;
        }
        let rel = path
            .strip_prefix(root)
            .map(|p| p.to_string_lossy().replace('\\', "/"))
            .unwrap_or_default();

        if path.is_dir() {
            let children = build_tree_inner(root, &path);
            nodes.push(TreeNode {
                name,
                path: rel,
                is_dir: true,
                children,
            });
        } else if path.extension().and_then(|e| e.to_str()) == Some("md") {
            nodes.push(TreeNode {
                name,
                path: rel,
                is_dir: false,
                children: vec![],
            });
        }
    }
    // Directories first, then files, both alphabetical.
    nodes.sort_by(|a, b| b.is_dir.cmp(&a.is_dir).then(a.name.cmp(&b.name)));
    nodes
}

/// Open a vault: build/refresh the index and start watching for changes.
pub fn open(app: &AppHandle, root_str: &str) -> Result<VaultInfo, String> {
    let root = PathBuf::from(root_str);
    if !root.is_dir() {
        return Err(format!("Not a directory: {}", root_str));
    }

    let mut conn = index::init_db(&db_path(&root)).map_err(|e| e.to_string())?;
    let note_count = index::reindex_all(&mut conn, &root).map_err(|e| e.to_string())?;

    let tree = build_tree(&root);
    let name = root
        .file_name()
        .map(|s| s.to_string_lossy().to_string())
        .unwrap_or_else(|| root_str.to_string());

    // Store the open vault.
    {
        let state = app.state::<AppState>();
        *state.vault.lock().unwrap() = Some(VaultCtx {
            root: root.clone(),
            conn,
        });
    }

    // Start watching the vault for external changes.
    match start_watcher(app, &root) {
        Ok(w) => {
            let state = app.state::<AppState>();
            *state.watcher.lock().unwrap() = Some(w);
        }
        Err(e) => eprintln!("Failed to start vault watcher: {e}"),
    }

    save_last_vault(app, root_str);

    // Allow the webview's asset protocol to read images from this vault.
    let _ = app.asset_protocol_scope().allow_directory(&root, true);

    Ok(VaultInfo {
        root: root_str.to_string(),
        name,
        tree,
        note_count,
    })
}

/// Watch the vault directory; emit `vault-changed` to the UI on `.md` changes.
fn start_watcher(app: &AppHandle, root: &Path) -> notify::Result<RecommendedWatcher> {
    let app_handle = app.clone();
    let last_emit = Mutex::new(Instant::now() - Duration::from_secs(1));

    let mut watcher = notify::recommended_watcher(move |res: notify::Result<notify::Event>| {
        let Ok(event) = res else { return };
        // Ignore access/metadata-only events. Reading a file during reindex bumps
        // its access/inode-metadata time, which would otherwise re-trigger an
        // endless reindex → vault-changed loop.
        match event.kind {
            EventKind::Access(_) | EventKind::Modify(ModifyKind::Metadata(_)) => return,
            _ => {}
        }
        let relevant = event.paths.iter().any(|p| {
            p.extension().and_then(|e| e.to_str()) == Some("md")
                && !p.components().any(|c| c.as_os_str() == ".onyx")
        });
        if !relevant {
            return;
        }
        // Coalesce bursts of FS events into at most one emit per 250ms.
        {
            let mut last = last_emit.lock().unwrap();
            if last.elapsed() < Duration::from_millis(250) {
                return;
            }
            *last = Instant::now();
        }
        let _ = app_handle.emit("vault-changed", ());
    })?;
    watcher.watch(root, RecursiveMode::Recursive)?;
    Ok(watcher)
}

/// Resolve a vault-relative path to an absolute path, guarding against escapes.
pub fn resolve(root: &Path, rel: &str) -> Result<PathBuf, String> {
    let rel = rel.trim_start_matches('/');
    let candidate = root.join(rel);
    // Prevent path traversal outside the vault.
    let normalized = normalize(&candidate);
    if !normalized.starts_with(root) {
        return Err("Path escapes the vault".into());
    }
    Ok(normalized)
}

/// Lexical path normalization (no filesystem access; handles `..` and `.`).
fn normalize(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for comp in path.components() {
        match comp {
            std::path::Component::ParentDir => {
                out.pop();
            }
            std::path::Component::CurDir => {}
            other => out.push(other.as_os_str()),
        }
    }
    out
}
