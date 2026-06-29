//! Night Shift: scheduled, deferred background intelligence.
//!
//! During the day Onyx records lightweight activity events. When the machine is
//! idle/charging (or on a schedule, or on demand) a checkpointed processor runs
//! heavy AI work and produces reviewable suggestions. Nothing is applied to the
//! user's notes without explicit approval.

pub mod events;
pub mod power;
pub mod processor;
pub mod queue;
pub mod storage;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Manager, State};

use crate::index;
use crate::vault::{self, AppState};

/// Managed state for the Night Shift subsystem (separate from the vault).
#[derive(Default)]
pub struct NightState {
    /// Connection to `<vault>/.onyx/assistant.db`; None until a vault is open.
    pub conn: Mutex<Option<Connection>>,
    /// Set to request the current run pause at the next checkpoint.
    pub stop: AtomicBool,
    /// True while a processing run is in flight.
    pub running: AtomicBool,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
pub struct NightSettings {
    /// "disabled" | "smart" | "scheduled" | "manual"
    pub mode: String,
    pub window_start: u32,
    pub window_end: u32,
    pub idle_minutes: u32,
    pub cpu_max: f64,
    /// How to apply summary suggestions: "append" (to the note) | "note" (new).
    pub summary_apply: String,
}

impl Default for NightSettings {
    fn default() -> Self {
        Self {
            mode: "smart".into(),
            window_start: 23,
            window_end: 3,
            idle_minutes: 5,
            cpu_max: 40.0,
            summary_apply: "append".into(),
        }
    }
}

// ---- assistant.db lifecycle ----

/// Open (or create) the assistant database for a freshly opened vault.
pub fn on_vault_opened(app: &AppHandle, root: &Path) {
    let path = root.join(".onyx").join("assistant.db");
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    match Connection::open(&path) {
        Ok(conn) => {
            if let Err(e) = storage::init_db(&conn) {
                eprintln!("night: init_db failed: {e}");
            }
            let st = app.state::<NightState>();
            *st.conn.lock().unwrap() = Some(conn);
        }
        Err(e) => eprintln!("night: could not open assistant.db: {e}"),
    }
}

/// Run a closure with the assistant DB connection, or None if not open / on error.
pub fn with_night<T>(
    app: &AppHandle,
    f: impl FnOnce(&Connection) -> rusqlite::Result<T>,
) -> Option<T> {
    let st = app.state::<NightState>();
    let guard = st.conn.lock().unwrap();
    let conn = guard.as_ref()?;
    match f(conn) {
        Ok(v) => Some(v),
        Err(e) => {
            eprintln!("night: db op failed: {e}");
            None
        }
    }
}

// ---- settings (persisted at <vault>/.onyx/night.json) ----

fn settings_path(app: &AppHandle) -> Option<std::path::PathBuf> {
    let state = app.state::<AppState>();
    let guard = state.vault.lock().unwrap();
    let ctx = guard.as_ref()?;
    Some(ctx.root.join(".onyx").join("night.json"))
}

pub fn load_settings(app: &AppHandle) -> NightSettings {
    settings_path(app)
        .and_then(|p| std::fs::read_to_string(p).ok())
        .and_then(|s| serde_json::from_str(&s).ok())
        .unwrap_or_default()
}

fn save_settings(app: &AppHandle, s: &NightSettings) {
    if let Some(p) = settings_path(app) {
        if let Some(parent) = p.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(data) = serde_json::to_string_pretty(s) {
            let _ = std::fs::write(p, data);
        }
    }
}

// ---- eligibility / scheduler ----

/// Should an automatic run start now, given the mode and machine state?
pub fn auto_eligible(s: &NightSettings) -> bool {
    match s.mode.as_str() {
        "smart" => {
            power::on_ac_power()
                && power::system_idle_secs() >= (s.idle_minutes as f64) * 60.0
                && power::cpu_busy_percent() < s.cpu_max
        }
        "scheduled" => {
            power::on_ac_power() && power::in_window(power::local_hour(), s.window_start, s.window_end)
        }
        _ => false, // disabled / manual never auto-start
    }
}

/// Start the coarse background scheduler (one tick/minute). It only ever spawns
/// the processor; the processor self-checks gating between jobs, so this thread
/// never blocks and can keep ticking.
pub fn start_scheduler(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(60));
        let night = app.state::<NightState>();
        if night.conn.lock().unwrap().is_none() {
            continue; // no vault open yet
        }
        if night.running.load(Ordering::SeqCst) {
            continue;
        }
        let settings = load_settings(&app);
        if auto_eligible(&settings) {
            let app2 = app.clone();
            tauri::async_runtime::spawn(async move {
                processor::run(app2, false).await;
            });
        }
    });
}

// ---- DTOs ----

#[derive(Serialize)]
pub struct Suggestion {
    pub id: i64,
    pub kind: String,
    pub confidence: f64,
    pub title: String,
    pub preview: String,
    pub body: String,
    pub target_path: String,
    pub created_at: i64,
}

#[derive(Serialize)]
pub struct ProcessingStatus {
    pub running: bool,
    pub mode: String,
    pub pending_jobs: i64,
    pub pending_suggestions: i64,
}

#[derive(Serialize)]
pub struct MorningReview {
    pub has_run: bool,
    pub finished_at: i64,
    pub notes_processed: i64,
    pub links_found: i64,
    pub summaries_created: i64,
    pub pending_suggestions: i64,
}

// ---- commands ----

#[tauri::command]
pub fn record_event(
    app: AppHandle,
    kind: String,
    entity: Option<String>,
    metadata: Option<String>,
) -> Result<(), String> {
    let now = now_secs();
    with_night(&app, |c| {
        events::record(c, &kind, entity.as_deref(), metadata.as_deref(), now)
    });
    Ok(())
}

#[tauri::command]
pub fn get_night_settings(app: AppHandle) -> NightSettings {
    load_settings(&app)
}

#[tauri::command]
pub fn set_night_settings(app: AppHandle, settings: NightSettings) -> Result<(), String> {
    save_settings(&app, &settings);
    Ok(())
}

#[tauri::command]
pub fn get_processing_status(app: AppHandle) -> ProcessingStatus {
    let night = app.state::<NightState>();
    let running = night.running.load(Ordering::SeqCst);
    let mode = load_settings(&app).mode;
    let pending_jobs = with_night(&app, |c| Ok(queue::pending_count(c))).unwrap_or(0);
    let pending_suggestions = with_night(&app, |c| {
        c.query_row(
            "SELECT COUNT(*) FROM suggestions WHERE status = 'pending'",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .unwrap_or(0);
    ProcessingStatus { running, mode, pending_jobs, pending_suggestions }
}

#[tauri::command]
pub fn start_processing(app: AppHandle) -> Result<(), String> {
    let night = app.state::<NightState>();
    if night.running.load(Ordering::SeqCst) {
        return Ok(());
    }
    let app2 = app.clone();
    tauri::async_runtime::spawn(async move {
        processor::run(app2, true).await; // explicit "Run now" bypasses gating
    });
    Ok(())
}

#[tauri::command]
pub fn pause_processing(app: AppHandle) -> Result<(), String> {
    let night = app.state::<NightState>();
    night.stop.store(true, Ordering::SeqCst);
    Ok(())
}

#[tauri::command]
pub fn get_suggestions(app: AppHandle) -> Vec<Suggestion> {
    with_night(&app, |c| {
        let mut stmt = c.prepare(
            "SELECT id, type, confidence, title, preview, body, target_path, created_at
             FROM suggestions WHERE status = 'pending' ORDER BY created_at DESC, id DESC",
        )?;
        let rows = stmt
            .query_map([], |r| {
                Ok(Suggestion {
                    id: r.get(0)?,
                    kind: r.get(1)?,
                    confidence: r.get(2)?,
                    title: r.get(3)?,
                    preview: r.get::<_, Option<String>>(4)?.unwrap_or_default(),
                    body: r.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    target_path: r.get::<_, Option<String>>(6)?.unwrap_or_default(),
                    created_at: r.get(7)?,
                })
            })?
            .filter_map(|r| r.ok())
            .collect::<Vec<_>>();
        Ok(rows)
    })
    .unwrap_or_default()
}

#[tauri::command]
pub fn get_morning_review(app: AppHandle) -> MorningReview {
    let pending = with_night(&app, |c| {
        c.query_row(
            "SELECT COUNT(*) FROM suggestions WHERE status = 'pending'",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .unwrap_or(0);

    with_night(&app, |c| {
        c.query_row(
            "SELECT finished_at, notes_processed, links_found, summaries_created
             FROM processing_runs WHERE status = 'complete' ORDER BY finished_at DESC LIMIT 1",
            [],
            |r| {
                Ok(MorningReview {
                    has_run: true,
                    finished_at: r.get::<_, Option<i64>>(0)?.unwrap_or(0),
                    notes_processed: r.get(1)?,
                    links_found: r.get(2)?,
                    summaries_created: r.get(3)?,
                    pending_suggestions: pending,
                })
            },
        )
    })
    .unwrap_or(MorningReview {
        has_run: false,
        finished_at: 0,
        notes_processed: 0,
        links_found: 0,
        summaries_created: 0,
        pending_suggestions: pending,
    })
}

#[tauri::command]
pub fn dismiss_suggestion(app: AppHandle, id: i64, never: bool) -> Result<(), String> {
    with_night(&app, |c| {
        if never {
            if let Ok(sig) = c.query_row(
                "SELECT signature FROM suggestions WHERE id = ?1",
                [id],
                |r| r.get::<_, Option<String>>(0),
            ) {
                if let Some(sig) = sig {
                    c.execute(
                        "INSERT INTO dismissals(signature, created_at) VALUES (?1, ?2)",
                        rusqlite::params![sig, now_secs()],
                    )?;
                }
            }
        }
        c.execute(
            "UPDATE suggestions SET status = 'dismissed' WHERE id = ?1",
            [id],
        )?;
        Ok(())
    });
    Ok(())
}

#[tauri::command]
pub fn accept_suggestion(
    app: AppHandle,
    state: State<'_, AppState>,
    id: i64,
) -> Result<String, String> {
    // Read the suggestion.
    let sug = with_night(&app, |c| {
        c.query_row(
            "SELECT type, title, body, target_path FROM suggestions WHERE id = ?1",
            [id],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?.unwrap_or_default(),
                    r.get::<_, Option<String>>(3)?.unwrap_or_default(),
                ))
            },
        )
    })
    .ok_or("Suggestion not found")?;
    let (kind, title, body, target) = sug;
    let settings = load_settings(&app);

    let applied_to = match kind.as_str() {
        "link" => apply_link(&state, &target, &body)?,
        "summary" => {
            if settings.summary_apply == "note" {
                let note = index::note_name(&target);
                create_note(&state, &format!("{note} — Summary"), &body)?
            } else {
                apply_append(&state, &target, "## Summary", &body)?
            }
        }
        "synthesis" | "subject" => create_note(&state, &title, &body)?,
        other => return Err(format!("Unknown suggestion type: {other}")),
    };

    with_night(&app, |c| {
        c.execute("UPDATE suggestions SET status = 'applied' WHERE id = ?1", [id])
            .map(|_| ())
    });
    Ok(applied_to)
}

// ---- apply helpers (mutate notes only on explicit accept) ----

fn apply_link(state: &State<'_, AppState>, note_path: &str, link_name: &str) -> Result<String, String> {
    crate::commands::with_vault(state, |ctx| {
        let abs = vault::resolve(&ctx.root, note_path)?;
        let mut content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
        let entry = format!("- [[{link_name}]]");
        if let Some(pos) = content.find("## Related") {
            // Insert right after the heading line.
            let after = content[pos..].find('\n').map(|n| pos + n + 1).unwrap_or(content.len());
            content.insert_str(after, &format!("{entry}\n"));
        } else {
            if !content.ends_with('\n') {
                content.push('\n');
            }
            content.push_str(&format!("\n## Related\n{entry}\n"));
        }
        std::fs::write(&abs, &content).map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, note_path, &content, now_secs()).map_err(|e| e.to_string())?;
        Ok(note_path.to_string())
    })
}

fn apply_append(
    state: &State<'_, AppState>,
    note_path: &str,
    heading: &str,
    body: &str,
) -> Result<String, String> {
    crate::commands::with_vault(state, |ctx| {
        let abs = vault::resolve(&ctx.root, note_path)?;
        let mut content = std::fs::read_to_string(&abs).map_err(|e| e.to_string())?;
        if !content.ends_with('\n') {
            content.push('\n');
        }
        content.push_str(&format!("\n{heading}\n\n{body}\n"));
        std::fs::write(&abs, &content).map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, note_path, &content, now_secs()).map_err(|e| e.to_string())?;
        Ok(note_path.to_string())
    })
}

fn create_note(state: &State<'_, AppState>, title: &str, body: &str) -> Result<String, String> {
    crate::commands::with_vault(state, |ctx| {
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
        std::fs::write(&abs, body).map_err(|e| e.to_string())?;
        index::index_note(&ctx.conn, &rel, body, now_secs()).map_err(|e| e.to_string())?;
        Ok(rel)
    })
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
