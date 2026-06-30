//! Atom extraction: turn a note's text into candidate knowledge units via the
//! chat model. Incremental (skips unchanged notes) and dedup'd by signature.

use rusqlite::params;
use std::collections::HashMap;
use tauri::{AppHandle, Emitter, Manager};

use crate::ai::{self, ChatMessage};
use crate::vault::{self, AppState};
use crate::{atoms, index};

use super::{load_settings, now_secs, storage, with_atoms};

const SYSTEM: &str = "You extract atomic units of knowledge from a document excerpt. Output ONLY a \
    JSON array. Each item: {\"kind\": one of [fact, signal, insight, pain_point, claim, action_item, \
    decision], \"text\": a single self-contained statement, \"confidence\": number 0..1}. An atom is \
    the SMALLEST meaningful, reusable piece of understanding — not a summary. Each text must stand on \
    its own without the source. A passage may yield zero atoms. Respond with the JSON array only, no \
    prose, no markdown.";

fn json_array(s: &str) -> Option<Vec<serde_json::Value>> {
    let start = s.find('[')?;
    let end = s.rfind(']')?;
    if end <= start {
        return None;
    }
    serde_json::from_str(&s[start..=end]).ok()
}

fn vault_root(app: &AppHandle) -> Option<std::path::PathBuf> {
    let st = app.state::<AppState>();
    let g = st.vault.lock().unwrap();
    g.as_ref().map(|c| c.root.clone())
}

fn all_note_paths(app: &AppHandle) -> Vec<String> {
    let st = app.state::<AppState>();
    let g = st.vault.lock().unwrap();
    let Some(ctx) = g.as_ref() else { return vec![] };
    let mut stmt = match ctx.conn.prepare("SELECT path FROM notes ORDER BY path") {
        Ok(s) => s,
        Err(_) => return vec![],
    };
    stmt.query_map([], |r| r.get::<_, String>(0))
        .map(|rows| rows.filter_map(|r| r.ok()).collect())
        .unwrap_or_default()
}

/// Extract atoms from one note. Returns the number of new atoms added. No-ops
/// when no chat model is configured or the note is unchanged since last synth.
pub async fn synthesize_note(app: &AppHandle, path: &str) -> Result<usize, String> {
    let cfg = ai::load_config(app);
    if cfg.chat_model.is_empty() {
        return Ok(0);
    }
    let settings = load_settings(app);
    let root = vault_root(app).ok_or("No vault is open")?;
    let abs = vault::resolve(&root, path)?;
    let content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
    let hash = storage::content_hash(&content);

    // Incremental: skip notes whose content hasn't changed since last synthesis.
    let unchanged = with_atoms(app, |c| {
        let prev: Option<String> = c
            .query_row(
                "SELECT content_hash FROM synth_state WHERE source_path=?1",
                [path],
                |r| r.get(0),
            )
            .ok();
        Ok(prev.as_deref() == Some(hash.as_str()))
    })
    .unwrap_or(false);
    if unchanged {
        return Ok(0);
    }

    let mut added = 0usize;
    for (idx, chunk) in index::chunk_content(&content, 1500) {
        if chunk.trim().len() < 80 {
            continue;
        }
        let messages = vec![
            ChatMessage { role: "system".into(), content: SYSTEM.into() },
            ChatMessage { role: "user".into(), content: chunk.chars().take(4000).collect() },
        ];
        let out = match ai::chat_complete(&cfg, messages).await {
            Ok(o) => o,
            Err(_) => continue,
        };
        let Some(arr) = json_array(&out) else { continue };
        for item in arr {
            let kind = item.get("kind").and_then(|v| v.as_str()).unwrap_or("").to_lowercase();
            let text = item.get("text").and_then(|v| v.as_str()).unwrap_or("").trim().to_string();
            if text.is_empty() || !settings.enabled_kinds.iter().any(|k| k == &kind) {
                continue;
            }
            let confidence = item.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.8);
            let sig = storage::signature(&kind, &text);
            let inserted = with_atoms(app, |c| {
                let exists: i64 = c.query_row(
                    "SELECT COUNT(*) FROM atoms WHERE source_path=?1 AND signature=?2",
                    params![path, sig],
                    |r| r.get(0),
                )?;
                if exists > 0 {
                    return Ok(false);
                }
                let now = now_secs();
                c.execute(
                    "INSERT INTO atoms(kind, text, source_path, source_chunk, confidence, status,
                                       signature, created_at, updated_at)
                     VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7, ?7)",
                    params![kind, text, path, idx, confidence, sig, now],
                )?;
                Ok(true)
            })
            .unwrap_or(false);
            if inserted {
                added += 1;
            }
        }
    }

    // Record synthesis state so unchanged notes are skipped next time.
    with_atoms(app, |c| {
        c.execute(
            "INSERT INTO synth_state(source_path, content_hash, synthesized_at) VALUES (?1, ?2, ?3)
             ON CONFLICT(source_path) DO UPDATE SET content_hash=excluded.content_hash,
                                                    synthesized_at=excluded.synthesized_at",
            params![path, hash, now_secs()],
        )
        .map(|_| ())
    });

    Ok(added)
}

/// Notes that are new or whose content changed since their last synthesis.
fn changed_notes(app: &AppHandle) -> Vec<String> {
    let Some(root) = vault_root(app) else { return vec![] };
    // Load the last-synthesized hash per source in one query.
    let prev: HashMap<String, String> = with_atoms(app, |c| {
        let mut stmt = c.prepare("SELECT source_path, content_hash FROM synth_state")?;
        let rows = stmt
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .filter_map(|r| r.ok())
            .collect();
        Ok(rows)
    })
    .unwrap_or_default();

    all_note_paths(app)
        .into_iter()
        .filter(|p| {
            let Ok(abs) = vault::resolve(&root, p) else { return false };
            let Ok(content) = std::fs::read_to_string(&abs) else { return false };
            prev.get(p) != Some(&storage::content_hash(&content)) // new or edited
        })
        .collect()
}

/// Synthesize only notes edited (or created) since the last synthesis. Emits
/// progress over that changed set, so unchanged notes are never re-processed.
pub async fn synthesize_vault(app: &AppHandle) -> usize {
    let targets = changed_notes(app);
    let total = targets.len();
    let mut added = 0usize;
    if total == 0 {
        let _ = app.emit("atoms:progress", serde_json::json!({ "done": 0, "total": 0, "added": 0 }));
        return 0;
    }
    for (i, p) in targets.iter().enumerate() {
        added += synthesize_note(app, p).await.unwrap_or(0);
        let _ = app.emit(
            "atoms:progress",
            serde_json::json!({ "done": i + 1, "total": total, "added": added }),
        );
        // Stop early if the run was cancelled (state cleared).
        if !app.state::<atoms::AtomsState>().running.load(std::sync::atomic::Ordering::SeqCst) {
            break;
        }
    }
    added
}
