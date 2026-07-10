//! Atomic Knowledge Synthesis: extract reusable units of knowledge ("Atoms")
//! from notes into a separate, rebuildable database. Source notes are never
//! modified; everything here is generated and curated by the user.

pub mod extract;
pub mod policy;
pub mod relate;
pub mod signals;
pub mod storage;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use tauri::{AppHandle, Emitter, Manager};

use crate::index;
use crate::vault::AppState;

/// The seven Atom kinds (the brief's six + Decision, used for traceability).
pub const ATOM_KINDS: [&str; 7] = [
    "fact",
    "signal",
    "insight",
    "pain_point",
    "claim",
    "action_item",
    "decision",
];

#[derive(Default)]
pub struct AtomsState {
    pub conn: Mutex<Option<Connection>>,
    pub running: AtomicBool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct AtomsSettings {
    pub enabled_kinds: Vec<String>,
    pub infer_relationships: bool,
    pub min_confidence: f64,
    /// Master switch for auto-approval (skip review).
    #[serde(default = "default_true")]
    pub auto_approve: bool,
    /// Auto-approve any atom whose confidence is at least this (kind-agnostic).
    #[serde(default = "default_auto_conf")]
    pub auto_approve_confidence: f64,
    /// Distinct sources required to mint a Signal atom.
    #[serde(default = "default_signal_sources")]
    pub signal_min_sources: i64,
}

fn default_true() -> bool {
    true
}
fn default_auto_conf() -> f64 {
    0.7
}
fn default_signal_sources() -> i64 {
    3
}

impl Default for AtomsSettings {
    fn default() -> Self {
        Self {
            enabled_kinds: ATOM_KINDS.iter().map(|s| s.to_string()).collect(),
            infer_relationships: true,
            min_confidence: 0.0,
            auto_approve: true,
            auto_approve_confidence: 0.7,
            signal_min_sources: 3,
        }
    }
}

// ---- lifecycle ----

pub fn on_vault_opened(app: &AppHandle, root: &Path) {
    let path = root.join(".onyx").join("atoms.db");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match Connection::open(&path) {
        Ok(conn) => {
            if let Err(e) = storage::init_db(&conn) {
                eprintln!("atoms: init_db failed: {e}");
            }
            let st = app.state::<AtomsState>();
            *st.conn.lock().unwrap() = Some(conn);
        }
        Err(e) => eprintln!("atoms: could not open atoms.db: {e}"),
    }
}

pub fn with_atoms<T>(
    app: &AppHandle,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Option<T> {
    let st = app.state::<AtomsState>();
    let guard = st.conn.lock().unwrap();
    let conn = guard.as_ref()?;
    match f(conn) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("atoms: db op failed: {e}");
            None
        }
    }
}

// ---- settings (<vault>/.onyx/atoms.json) ----

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let state = app.state::<AppState>();
    let guard = state.vault.lock().unwrap();
    Some(guard.as_ref()?.root.join(".onyx").join("atoms.json"))
}

pub fn load_settings(app: &AppHandle) -> AtomsSettings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &AtomsSettings) {
    if let Some(p) = settings_path(app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(data) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(p, data);
        }
    }
}

// ---- DTOs ----

#[derive(Serialize)]
pub struct Atom {
    pub id: i64,
    pub kind: String,
    pub text: String,
    pub source_path: String,
    pub source_heading: Option<String>,
    pub confidence: f64,
    pub substantiation: f64,
    pub evidence: Option<String>,
    pub auto_approved: bool,
    pub status: String,
    pub created_at: i64,
}

#[derive(Serialize)]
pub struct PendingGroup {
    pub source_path: String,
    pub source_name: String,
    pub atoms: Vec<Atom>,
}

#[derive(Serialize)]
pub struct RelationView {
    pub kind: String,
    pub direction: String, // "out" | "in"
    pub atom: Atom,
}

#[derive(Serialize)]
pub struct DecisionTrace {
    pub decision: Atom,
    pub supporting: Vec<Atom>,
}

#[derive(Serialize)]
pub struct AtomsStatus {
    pub running: bool,
    pub pending: i64,
    pub approved: i64,
    pub total: i64,
}

#[derive(Deserialize, Default)]
pub struct AtomFilter {
    pub kind: Option<String>,
    pub query: Option<String>,
    pub source: Option<String>,
    pub relation: Option<String>, // e.g. "contradicts" → only atoms having that relation
}

fn atom_from_row(r: &rusqlite::Row) -> rusqlite::Result<Atom> {
    Ok(Atom {
        id: r.get("id")?,
        kind: r.get("kind")?,
        text: r.get("text")?,
        source_path: r.get("source_path")?,
        source_heading: r.get("source_heading")?,
        confidence: r.get("confidence")?,
        substantiation: r.get::<_, Option<f64>>("substantiation")?.unwrap_or(0.5),
        evidence: r.get("evidence")?,
        auto_approved: r.get::<_, Option<i64>>("auto_approved")?.unwrap_or(0) != 0,
        status: r.get("status")?,
        created_at: r.get("created_at")?,
    })
}

const ATOM_COLS: &str =
    "id, kind, text, source_path, source_heading, confidence, substantiation, evidence, \
     auto_approved, status, created_at";

pub fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}

/// Read a note's text from the open vault (empty string if unavailable).
fn read_note_text(app: &AppHandle, path: &str) -> String {
    let st = app.state::<AppState>();
    let g = st.vault.lock().unwrap();
    let Some(ctx) = g.as_ref() else { return String::new() };
    match crate::vault::resolve(&ctx.root, path) {
        Ok(abs) => std::fs::read_to_string(abs).unwrap_or_default(),
        Err(_) => String::new(),
    }
}

/// A retrieved atom for grounding AI chat / tools.
pub struct AtomHit {
    pub kind: String,
    pub text: String,
    pub source_path: String,
}

/// Retrieve the approved atoms most relevant to `query` (semantic search over
/// atom embeddings). Empty if there's no embed model or no embedded atoms.
pub async fn retrieve(app: &AppHandle, query: &str, k: usize) -> Vec<AtomHit> {
    let cfg = crate::ai::load_config(app);
    if cfg.embed_model.is_empty() || query.trim().is_empty() {
        return vec![];
    }
    let emb = match crate::ai::embed(&cfg, vec![query.to_string()]).await {
        Ok(v) => v.into_iter().next(),
        Err(_) => None,
    };
    let Some(vec) = emb else { return vec![] };
    let ids = with_atoms(app, |c| storage::search_atom_vec(c, &vec, k, -1)).unwrap_or_default();
    let mut hits = Vec::new();
    for (id, _dist) in ids {
        if let Some(hit) = with_atoms(app, |c| {
            c.query_row(
                "SELECT kind, text, source_path FROM atoms WHERE id=?1 AND status='approved'",
                [id],
                |r| {
                    Ok(AtomHit {
                        kind: r.get(0)?,
                        text: r.get(1)?,
                        source_path: r.get(2)?,
                    })
                },
            )
        }) {
            hits.push(hit);
        }
    }
    hits
}

/// Format retrieved atoms as a context block for an AI prompt. Empty string if
/// none, so callers can append unconditionally.
pub async fn context_block(app: &AppHandle, query: &str, k: usize) -> String {
    let hits = retrieve(app, query, k).await;
    if hits.is_empty() {
        return String::new();
    }
    let mut out = String::from("\n\nRelevant knowledge atoms (curated facts/insights/claims/etc., cite their source notes as [[Title]]):\n");
    for h in hits {
        out.push_str(&format!(
            "- ({}) {} — source: [[{}]]\n",
            h.kind,
            h.text,
            index::note_name(&h.source_path)
        ));
    }
    out
}

// ---- commands: synthesis ----

#[tauri::command]
pub fn atoms_get_settings(app: AppHandle) -> AtomsSettings {
    load_settings(&app)
}

#[tauri::command]
pub fn atoms_set_settings(app: AppHandle, settings: AtomsSettings) -> Result<(), String> {
    save_settings(&app, &settings);
    Ok(())
}

#[tauri::command]
pub fn atoms_status(app: AppHandle) -> AtomsStatus {
    let st = app.state::<AtomsState>();
    let running = st.running.load(Ordering::SeqCst);
    let (pending, approved, total) = with_atoms(&app, |c| {
        let p = c.query_row("SELECT COUNT(*) FROM atoms WHERE status='pending'", [], |r| r.get(0))?;
        let a = c.query_row("SELECT COUNT(*) FROM atoms WHERE status='approved'", [], |r| r.get(0))?;
        let t = c.query_row("SELECT COUNT(*) FROM atoms", [], |r| r.get::<_, i64>(0))?;
        Ok((p, a, t))
    })
    .unwrap_or((0, 0, 0));
    AtomsStatus { running, pending, approved, total }
}

#[tauri::command]
pub fn atoms_synthesize_note(app: AppHandle, path: String) -> Result<(), String> {
    spawn_synthesis(app, SynthScope::Note(path));
    Ok(())
}

#[tauri::command]
pub fn atoms_synthesize_vault(app: AppHandle) -> Result<(), String> {
    spawn_synthesis(app, SynthScope::Vault);
    Ok(())
}

#[tauri::command]
pub fn atoms_rebuild(app: AppHandle) -> Result<(), String> {
    spawn_synthesis(app, SynthScope::Rebuild);
    Ok(())
}

enum SynthScope {
    Note(String),
    Vault,
    Rebuild,
}

fn spawn_synthesis(app: AppHandle, scope: SynthScope) {
    let st = app.state::<AtomsState>();
    if st
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // already running
    }
    tauri::async_runtime::spawn(async move {
        let added = match scope {
            SynthScope::Note(p) => {
                let n = extract::synthesize_note(&app, &p).await.unwrap_or(0);
                extract::post_synthesis(&app).await;
                n
            }
            SynthScope::Vault => extract::synthesize_vault(&app).await,
            SynthScope::Rebuild => {
                let _ = with_atoms(&app, |c| storage::clear_all(c));
                extract::synthesize_vault(&app).await
            }
        };
        app.state::<AtomsState>().running.store(false, Ordering::SeqCst);
        let _ = app.emit("atoms:done", serde_json::json!({ "added": added }));
    });
}

// ---- commands: review / curation ----

#[tauri::command]
pub fn get_pending_atoms(app: AppHandle) -> Vec<PendingGroup> {
    let atoms = with_atoms(&app, |c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {ATOM_COLS} FROM atoms WHERE status='pending' ORDER BY source_path, id"
        ))?;
        let rows = stmt
            .query_map([], atom_from_row)?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        Ok(rows)
    })
    .unwrap_or_default();

    // Group by source path, preserving order.
    let mut groups: Vec<PendingGroup> = Vec::new();
    for a in atoms {
        if let Some(g) = groups.last_mut().filter(|g| g.source_path == a.source_path) {
            g.atoms.push(a);
        } else {
            groups.push(PendingGroup {
                source_name: index::note_name(&a.source_path),
                source_path: a.source_path.clone(),
                atoms: vec![a],
            });
        }
    }
    groups
}

#[tauri::command]
pub fn get_atoms(app: AppHandle, filter: AtomFilter) -> Vec<Atom> {
    with_atoms(&app, |c| {
        let mut sql = format!("SELECT {ATOM_COLS} FROM atoms WHERE status='approved'");
        if filter.kind.is_some() {
            sql.push_str(" AND kind = :kind");
        }
        if filter.source.is_some() {
            sql.push_str(" AND source_path = :source");
        }
        if filter.query.is_some() {
            sql.push_str(" AND text LIKE :q");
        }
        if filter.relation.is_some() {
            sql.push_str(
                " AND id IN (SELECT from_id FROM atom_relations WHERE kind = :rel
                             UNION SELECT to_id FROM atom_relations WHERE kind = :rel)",
            );
        }
        sql.push_str(" ORDER BY kind, id DESC");

        let like = filter.query.as_ref().map(|q| format!("%{q}%"));
        let mut stmt = c.prepare(&sql)?;
        // Bind only the params present.
        let mut params: Vec<(&str, &dyn rusqlite::ToSql)> = Vec::new();
        if let Some(k) = &filter.kind {
            params.push((":kind", k));
        }
        if let Some(s) = &filter.source {
            params.push((":source", s));
        }
        if let Some(l) = &like {
            params.push((":q", l));
        }
        if let Some(rel) = &filter.relation {
            params.push((":rel", rel));
        }
        let rows = stmt
            .query_map(params.as_slice(), atom_from_row)?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        Ok(rows)
    })
    .unwrap_or_default()
}

/// Approved atoms drawn from every note that references `page` — the data
/// source for atom-backed primitives (Decisions / Pain points / Insights).
/// Atoms are anchored to a source note (not a block), so this is note-granular.
#[tauri::command]
pub fn atoms_for_page(app: AppHandle, page: String) -> Vec<Atom> {
    // The set of notes whose blocks reference this page (from the main index).
    let sources: std::collections::HashSet<String> = {
        let vault_state = app.state::<AppState>();
        let guard = vault_state.vault.lock().unwrap();
        match guard.as_ref() {
            Some(ctx) => index::block_backlinks(&ctx.conn, &page)
                .map(|refs| refs.into_iter().map(|r| r.source_path).collect())
                .unwrap_or_default(),
            None => return Vec::new(),
        }
    };
    if sources.is_empty() {
        return Vec::new();
    }
    with_atoms(&app, |c| {
        let mut stmt =
            c.prepare(&format!("SELECT {ATOM_COLS} FROM atoms WHERE status='approved' ORDER BY kind, id DESC"))?;
        let rows = stmt
            .query_map([], atom_from_row)?
            .filter_map(|r| r.ok())
            .filter(|a: &Atom| sources.contains(&a.source_path))
            .collect::<Vec<_>>();
        Ok(rows)
    })
    .unwrap_or_default()
}

#[tauri::command]
pub fn approve_atom(app: AppHandle, id: i64) -> Result<(), String> {
    with_atoms(&app, |c| {
        c.execute(
            "UPDATE atoms SET status='approved', updated_at=?2 WHERE id=?1",
            params![id, now_secs()],
        )?;
        record_feedback(c, id, "approve");
        Ok(())
    });
    // Embed the atom (always, so AI chat/tools can retrieve it) and infer
    // relationships (gated by the setting) — both in the background.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        relate::relate_atom(&app2, id).await;
    });
    Ok(())
}

/// Approve every pending atom at once (clears the review queue).
#[tauri::command]
pub fn atoms_approve_all(app: AppHandle) -> Result<i64, String> {
    let n = with_atoms(&app, |c| {
        let now = now_secs();
        c.execute(
            "INSERT INTO feedback(atom_id, kind, decision, confidence, substantiation, created_at)
             SELECT id, kind, 'approve', confidence, substantiation, ?1 FROM atoms WHERE status='pending'",
            params![now],
        )?;
        let changed = c.execute(
            "UPDATE atoms SET status='approved', updated_at=?1 WHERE status='pending'",
            params![now],
        )?;
        Ok(changed as i64)
    })
    .unwrap_or(0);
    // Embed the newly-approved atoms + refresh Signals in the background.
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        extract::post_synthesis(&app2).await;
    });
    Ok(n)
}

#[tauri::command]
pub fn reject_atom(app: AppHandle, id: i64) -> Result<(), String> {
    with_atoms(&app, |c| {
        c.execute(
            "UPDATE atoms SET status='rejected', updated_at=?2 WHERE id=?1",
            params![id, now_secs()],
        )?;
        record_feedback(c, id, "reject");
        Ok(())
    });
    Ok(())
}

#[tauri::command]
pub fn edit_atom(app: AppHandle, id: i64, text: String, kind: String) -> Result<(), String> {
    if !ATOM_KINDS.contains(&kind.as_str()) {
        return Err(format!("Unknown atom kind: {kind}"));
    }
    let sig = storage::signature(&kind, &text);
    with_atoms(&app, |c| {
        // Capture the prior kind so a reclassification can teach the extractor.
        let old_kind: Option<String> = c
            .query_row("SELECT kind FROM atoms WHERE id=?1", [id], |r| r.get(0))
            .ok();
        c.execute(
            "UPDATE atoms SET text=?2, kind=?3, signature=?4, updated_at=?5 WHERE id=?1",
            params![id, text, kind, sig, now_secs()],
        )?;
        if let Some(old) = old_kind {
            if old != kind {
                let now = now_secs();
                c.execute(
                    "INSERT INTO feedback(atom_id, kind, from_kind, to_kind, decision, created_at)
                     VALUES (?1, ?2, ?3, ?4, 'reclassify', ?5)",
                    params![id, kind, old, kind, now],
                )?;
                c.execute(
                    "INSERT INTO corrections(text, wrong_kind, right_kind, created_at)
                     VALUES (?1, ?2, ?3, ?4)",
                    params![text, old, kind, now],
                )?;
            }
        }
        Ok(())
    });
    Ok(())
}

/// Record an approve/reject decision with the atom's kind/confidence/substantiation.
fn record_feedback(c: &Connection, id: i64, decision: &str) {
    let _ = c.execute(
        "INSERT INTO feedback(atom_id, kind, decision, confidence, substantiation, created_at)
         SELECT id, kind, ?2, confidence, substantiation, ?3 FROM atoms WHERE id=?1",
        params![id, decision, now_secs()],
    );
}

#[tauri::command]
pub fn merge_atoms(
    app: AppHandle,
    ids: Vec<i64>,
    text: String,
    kind: String,
) -> Result<i64, String> {
    if ids.is_empty() {
        return Err("Nothing to merge".into());
    }
    let sig = storage::signature(&kind, &text);
    with_atoms(&app, |c| {
        // Inherit source from the first atom.
        let (src, chunk, heading): (String, Option<i64>, Option<String>) = c.query_row(
            "SELECT source_path, source_chunk, source_heading FROM atoms WHERE id=?1",
            [ids[0]],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )?;
        let now = now_secs();
        c.execute(
            "INSERT INTO atoms(kind, text, source_path, source_chunk, source_heading, confidence,
                               status, signature, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, 0.9, 'approved', ?6, ?7, ?7)",
            params![kind, text, src, chunk, heading, sig, now],
        )?;
        let new_id = c.last_insert_rowid();
        for old in &ids {
            c.execute(
                "UPDATE atoms SET status='merged', merged_into=?2, updated_at=?3 WHERE id=?1",
                params![old, new_id, now],
            )?;
        }
        Ok(new_id)
    })
    .ok_or_else(|| "merge failed".to_string())
}

#[tauri::command]
pub fn split_atom(app: AppHandle, id: i64, texts: Vec<String>) -> Result<(), String> {
    let texts: Vec<String> = texts.into_iter().filter(|t| !t.trim().is_empty()).collect();
    if texts.len() < 2 {
        return Err("Provide at least two parts to split into".into());
    }
    with_atoms(&app, |c| {
        let (kind, src, chunk, heading): (String, String, Option<i64>, Option<String>) =
            c.query_row(
                "SELECT kind, source_path, source_chunk, source_heading FROM atoms WHERE id=?1",
                [id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )?;
        let now = now_secs();
        for t in &texts {
            let sig = storage::signature(&kind, t);
            c.execute(
                "INSERT INTO atoms(kind, text, source_path, source_chunk, source_heading, confidence,
                                   status, signature, created_at, updated_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0.8, 'pending', ?6, ?7, ?7)",
                params![kind, t, src, chunk, heading, sig, now],
            )?;
        }
        c.execute(
            "UPDATE atoms SET status='split', updated_at=?2 WHERE id=?1",
            params![id, now],
        )?;
        Ok(())
    });
    Ok(())
}

// ---- commands: relationships / traceability ----

fn fetch_atom(c: &Connection, id: i64) -> rusqlite::Result<Atom> {
    c.query_row(
        &format!("SELECT {ATOM_COLS} FROM atoms WHERE id=?1"),
        [id],
        atom_from_row,
    )
}

#[tauri::command]
pub fn get_relations(app: AppHandle, atom_id: i64) -> Vec<RelationView> {
    with_atoms(&app, |c| {
        let mut out = Vec::new();
        // Outgoing.
        let mut s1 = c.prepare("SELECT kind, to_id FROM atom_relations WHERE from_id=?1")?;
        for row in s1.query_map([atom_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            if let Ok((kind, other)) = row {
                if let Ok(atom) = fetch_atom(c, other) {
                    out.push(RelationView { kind, direction: "out".into(), atom });
                }
            }
        }
        // Incoming.
        let mut s2 = c.prepare("SELECT kind, from_id FROM atom_relations WHERE to_id=?1")?;
        for row in s2.query_map([atom_id], |r| Ok((r.get::<_, String>(0)?, r.get::<_, i64>(1)?)))? {
            if let Ok((kind, other)) = row {
                if let Ok(atom) = fetch_atom(c, other) {
                    out.push(RelationView { kind, direction: "in".into(), atom });
                }
            }
        }
        Ok(out)
    })
    .unwrap_or_default()
}

#[tauri::command]
pub fn get_decision_trace(app: AppHandle, atom_id: i64) -> Option<DecisionTrace> {
    with_atoms(&app, |c| {
        let decision = fetch_atom(c, atom_id)?;
        // Supporting atoms = those linked to the decision via supports/used_in_decision.
        let mut stmt = c.prepare(&format!(
            "SELECT {ATOM_COLS} FROM atoms WHERE id IN (
               SELECT from_id FROM atom_relations
               WHERE to_id=?1 AND kind IN ('supports','used_in_decision')
             ) ORDER BY kind, id"
        ))?;
        let supporting = stmt
            .query_map([atom_id], atom_from_row)?
            .filter_map(|r| r.ok())
            .collect();
        Ok(DecisionTrace { decision, supporting })
    })
}

#[tauri::command]
pub fn get_decisions(app: AppHandle) -> Vec<Atom> {
    with_atoms(&app, |c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {ATOM_COLS} FROM atoms WHERE kind='decision' AND status='approved' ORDER BY id DESC"
        ))?;
        let rows: Vec<Atom> = stmt.query_map([], atom_from_row)?.filter_map(|r| r.ok()).collect();
        Ok(rows)
    })
    .unwrap_or_default()
}

// ---- knowledge surfaces: per-note panel, tensions, graph ----

#[derive(Serialize)]
pub struct NoteKnowledge {
    pub derived: Vec<Atom>,
    pub related: Vec<Atom>,
}

/// Atoms derived from a note, plus approved atoms from elsewhere relevant to it.
#[tauri::command]
pub async fn get_note_knowledge(app: AppHandle, path: String) -> NoteKnowledge {
    let derived = with_atoms(&app, |c| {
        let mut stmt = c.prepare(&format!(
            "SELECT {ATOM_COLS} FROM atoms WHERE source_path=?1 AND status='approved' ORDER BY id"
        ))?;
        let rows: Vec<Atom> =
            stmt.query_map([&path], atom_from_row)?.filter_map(|r| r.ok()).collect();
        Ok(rows)
    })
    .unwrap_or_default();

    // Related: semantic retrieval over the note's text, excluding its own atoms.
    let related_hits = {
        let content = read_note_text(&app, &path);
        if content.is_empty() {
            vec![]
        } else {
            retrieve(&app, &content, 12).await
        }
    };
    let related = with_atoms(&app, |c| {
        let mut out = Vec::new();
        for h in &related_hits {
            if h.source_path == path {
                continue;
            }
            if let Ok(a) = c.query_row(
                &format!("SELECT {ATOM_COLS} FROM atoms WHERE source_path=?1 AND text=?2 AND status='approved' LIMIT 1"),
                params![h.source_path, h.text],
                atom_from_row,
            ) {
                out.push(a);
            }
            if out.len() >= 8 {
                break;
            }
        }
        Ok(out)
    })
    .unwrap_or_default();

    NoteKnowledge { derived, related }
}

#[derive(Serialize)]
pub struct AtomPair {
    pub a: Atom,
    pub b: Atom,
    pub kind: String,
}

#[derive(Serialize)]
pub struct Tensions {
    pub contradictions: Vec<AtomPair>,
    pub duplicates: Vec<AtomPair>,
}

#[tauri::command]
pub fn get_tensions(app: AppHandle) -> Tensions {
    with_atoms(&app, |c| {
        let pairs = |rel_sql: &str| -> rusqlite::Result<Vec<AtomPair>> {
            let mut stmt = c.prepare(rel_sql)?;
            let ids: Vec<(i64, i64, String)> = stmt
                .query_map([], |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)))?
                .filter_map(|r| r.ok())
                .collect();
            let mut out = Vec::new();
            for (from, to, kind) in ids {
                if let (Ok(a), Ok(b)) = (fetch_atom(c, from), fetch_atom(c, to)) {
                    if a.status == "approved" && b.status == "approved" {
                        out.push(AtomPair { a, b, kind: kind.clone() });
                    }
                }
            }
            Ok(out)
        };

        let contradictions = pairs(
            "SELECT from_id, to_id, kind FROM atom_relations WHERE kind='contradicts'",
        )?;
        // Duplicates: explicit similar_to links, plus identical signature across sources.
        let mut duplicates = pairs(
            "SELECT from_id, to_id, kind FROM atom_relations WHERE kind='similar_to'",
        )?;
        let mut sig_stmt = c.prepare(
            "SELECT a.id, b.id FROM atoms a JOIN atoms b
             ON a.signature = b.signature AND a.id < b.id AND a.source_path != b.source_path
             WHERE a.status='approved' AND b.status='approved'",
        )?;
        for row in sig_stmt.query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, i64>(1)?)))? {
            if let Ok((x, y)) = row {
                if let (Ok(a), Ok(b)) = (fetch_atom(c, x), fetch_atom(c, y)) {
                    duplicates.push(AtomPair { a, b, kind: "duplicate".into() });
                }
            }
        }
        Ok(Tensions { contradictions, duplicates })
    })
    .unwrap_or(Tensions { contradictions: vec![], duplicates: vec![] })
}

#[derive(Serialize)]
pub struct AtomGraphNode {
    pub id: String,
    pub label: String,
    pub kind: String,
    pub source_path: String,
}

#[derive(Serialize)]
pub struct AtomGraphEdge {
    pub source: String,
    pub target: String,
    pub kind: String,
}

#[derive(Serialize)]
pub struct AtomGraph {
    pub nodes: Vec<AtomGraphNode>,
    pub edges: Vec<AtomGraphEdge>,
}

#[tauri::command]
pub fn get_atom_graph(app: AppHandle) -> AtomGraph {
    with_atoms(&app, |c| {
        let mut ns = c.prepare(
            "SELECT id, kind, text, source_path FROM atoms WHERE status='approved'",
        )?;
        let nodes: Vec<AtomGraphNode> = ns
            .query_map([], |r| {
                let id: i64 = r.get(0)?;
                let kind: String = r.get(1)?;
                let text: String = r.get(2)?;
                Ok(AtomGraphNode {
                    id: format!("a{id}"),
                    label: text.chars().take(60).collect(),
                    kind,
                    source_path: r.get(3)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        let mut es = c.prepare(
            "SELECT r.from_id, r.to_id, r.kind FROM atom_relations r
             JOIN atoms a ON a.id=r.from_id AND a.status='approved'
             JOIN atoms b ON b.id=r.to_id AND b.status='approved'",
        )?;
        let edges: Vec<AtomGraphEdge> = es
            .query_map([], |r| {
                Ok(AtomGraphEdge {
                    source: format!("a{}", r.get::<_, i64>(0)?),
                    target: format!("a{}", r.get::<_, i64>(1)?),
                    kind: r.get(2)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect();
        Ok(AtomGraph { nodes, edges })
    })
    .unwrap_or(AtomGraph { nodes: vec![], edges: vec![] })
}
