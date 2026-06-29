//! The staged, checkpointed overnight pipeline. Reuses existing AI commands and
//! writes reviewable suggestions — it never modifies notes.

use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager};

use crate::ai;
use crate::vault::{self, AppState};
use crate::{commands, index};

use super::queue::{self, Job};
use super::{auto_eligible, load_settings, with_night, NightSettings, NightState};

/// Default confidence for model-produced suggestions (already filtered by the
/// model). Anything below 0.80 is discarded at finalize time per the spec.
const CONFIDENCE: f64 = 0.85;

/// Run one overnight processing pass. Safe to call when no model is configured
/// (each AI stage no-ops). Resumable: stopping leaves remaining jobs PENDING.
///
/// `force` bypasses power/idle gating — used by the explicit "Run now" action so
/// it always runs to completion. Scheduler-initiated runs pass `false`.
pub async fn run(app: AppHandle, force: bool) {
    let night = app.state::<NightState>();
    if night
        .running
        .compare_exchange(false, true, Ordering::SeqCst, Ordering::SeqCst)
        .is_err()
    {
        return; // already running
    }
    night.stop.store(false, Ordering::SeqCst);

    let result = run_inner(&app, force).await;
    if let Err(e) = result {
        let _ = app.emit("night:error", serde_json::json!({ "error": e }));
    }

    let night = app.state::<NightState>();
    night.running.store(false, Ordering::SeqCst);
    let _ = app.emit("night:done", serde_json::json!({}));
}

async fn run_inner(app: &AppHandle, force: bool) -> Result<(), String> {
    let settings = load_settings(app);
    let now = now_secs();

    // Plan jobs from activity since the last run (vault + night locks, no await).
    let since = with_night(app, |c| {
        c.query_row(
            "SELECT COALESCE(MAX(started_at), 0) FROM processing_runs",
            [],
            |r| r.get::<_, i64>(0),
        )
    })
    .unwrap_or(0);

    {
        let state = app.state::<AppState>();
        let vguard = state.vault.lock().unwrap();
        if let Some(ctx) = vguard.as_ref() {
            let _ = with_night(app, |nc| queue::plan_jobs(&ctx.conn, nc, since, now));
        }
    }

    // Open a processing-run row.
    let run_id = with_night(app, |c| {
        c.execute(
            "INSERT INTO processing_runs(started_at, status) VALUES (?1, 'running')",
            [now],
        )?;
        Ok(c.last_insert_rowid())
    })
    .ok_or("Could not open assistant database")?;

    let jobs = with_night(app, |c| queue::pending_jobs(c)).unwrap_or_default();
    let total = jobs.len();

    let mut notes_processed = 0i64;
    let mut links_found = 0i64;
    let mut summaries_created = 0i64;
    let mut stopped = false;

    for (i, job) in jobs.iter().enumerate() {
        if !should_continue(app, &settings, force) {
            stopped = true;
            break;
        }
        let _ = app.emit(
            "night:progress",
            serde_json::json!({ "stage": job.kind, "done": i, "total": total }),
        );
        let _ = with_night(app, |c| queue::set_job_status(c, job.id, "RUNNING"));

        let outcome = process_job(app, job).await;
        match outcome {
            Ok(JobResult { notes, links, summaries }) => {
                notes_processed += notes;
                links_found += links;
                summaries_created += summaries;
                let _ = with_night(app, |c| queue::set_job_status(c, job.id, "COMPLETE"));
            }
            Err(_) => {
                let _ = with_night(app, |c| queue::set_job_status(c, job.id, "FAILED"));
            }
        }
    }

    // Finalize: drop low-confidence + dismissed, prune, close the run.
    let final_status = if stopped { "paused" } else { "complete" };
    let _ = with_night(app, |c| {
        c.execute("DELETE FROM suggestions WHERE confidence < 0.80 AND status = 'pending'", [])?;
        c.execute(
            "UPDATE processing_runs SET finished_at=?2, notes_processed=?3, links_found=?4, \
             summaries_created=?5, status=?6 WHERE id=?1",
            rusqlite::params![run_id, now_secs(), notes_processed, links_found, summaries_created, final_status],
        )?;
        super::storage::prune(c, now_secs())?;
        Ok(())
    });

    Ok(())
}

struct JobResult {
    notes: i64,
    links: i64,
    summaries: i64,
}

async fn process_job(app: &AppHandle, job: &Job) -> Result<JobResult, String> {
    let mut res = JobResult { notes: 0, links: 0, summaries: 0 };
    match job.kind.as_str() {
        "INDEX" => {
            let state = app.state::<AppState>();
            let _ = commands::ai_index_note(app.clone(), state, job.payload.clone()).await?;
            res.notes = 1;
        }
        "LINK_DISCOVERY" => {
            let state = app.state::<AppState>();
            let links = commands::ai_suggest_links(app.clone(), state, job.payload.clone())
                .await
                .unwrap_or_default();
            let note = index::note_name(&job.payload);
            for l in links {
                let title = format!("Link “{}” → [[{}]]", note, l.name);
                let sig = format!("link|{}|{}", job.payload, l.name);
                if store_suggestion(app, "link", CONFIDENCE, &title, &l.reason, &l.name, &job.payload, &sig) {
                    res.links += 1;
                }
            }
        }
        "SUMMARIZE" => {
            if let Some((title, preview, body)) = summarize(app, &job.payload).await {
                let sig = format!("summary|{}", job.payload);
                if store_suggestion(app, "summary", CONFIDENCE, &title, &preview, &body, &job.payload, &sig) {
                    res.summaries = 1;
                }
            }
        }
        "SYNTHESIZE" => {
            let tag = job.payload.strip_prefix("tag:").unwrap_or(&job.payload).to_string();
            let state = app.state::<AppState>();
            if let Ok(doc) = commands::ai_synthesize(app.clone(), state, "tag".into(), tag.clone()).await {
                let title = doc.title.clone();
                let sig = format!("synthesis|tag:{tag}");
                let preview = format!("Synthesis of #{tag}");
                store_suggestion(app, "synthesis", CONFIDENCE, &title, &preview, &doc.content, "", &sig);
            }
        }
        _ => {}
    }
    Ok(res)
}

/// Summarize a note into key points via the chat model. None if unavailable.
async fn summarize(app: &AppHandle, path: &str) -> Option<(String, String, String)> {
    let cfg = ai::load_config(app);
    if cfg.chat_model.is_empty() {
        return None;
    }
    let root = {
        let state = app.state::<AppState>();
        let guard = state.vault.lock().unwrap();
        guard.as_ref().map(|c| c.root.clone())?
    };
    let abs = vault::resolve(&root, path).ok()?;
    let content = std::fs::read_to_string(&abs).ok()?;
    if content.trim().len() < 200 {
        return None; // too short to be worth summarizing
    }
    let body_in: String = content.chars().take(6000).collect();
    let messages = vec![
        ai::ChatMessage {
            role: "system".into(),
            content: "Summarize the note into a short markdown list of 3-6 key points. Output ONLY \
                      the bullet list, no preamble."
                .into(),
        },
        ai::ChatMessage { role: "user".into(), content: body_in },
    ];
    let out = ai::chat_complete(&cfg, messages).await.ok()?;
    let note = index::note_name(path);
    let preview = out.lines().find(|l| !l.trim().is_empty()).unwrap_or("").to_string();
    Some((format!("Summary: {note}"), preview, out))
}

/// Insert a suggestion unless its signature was previously dismissed. Returns
/// true if stored.
fn store_suggestion(
    app: &AppHandle,
    kind: &str,
    confidence: f64,
    title: &str,
    preview: &str,
    body: &str,
    target: &str,
    signature: &str,
) -> bool {
    with_night(app, |c| {
        let dismissed: i64 = c.query_row(
            "SELECT COUNT(*) FROM dismissals WHERE signature = ?1",
            [signature],
            |r| r.get(0),
        )?;
        if dismissed > 0 {
            return Ok(false);
        }
        c.execute(
            "INSERT INTO suggestions(type, confidence, title, preview, body, target_path, signature, created_at, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending')",
            rusqlite::params![kind, confidence, title, preview, body, target, signature, now_secs()],
        )?;
        Ok(true)
    })
    .unwrap_or(false)
}

/// May the run keep going? Honors an explicit pause; a forced or manual-mode run
/// ignores power/idle gating, otherwise gating is re-checked each job.
fn should_continue(app: &AppHandle, settings: &NightSettings, force: bool) -> bool {
    let night = app.state::<NightState>();
    if night.stop.load(Ordering::SeqCst) {
        return false;
    }
    if force || settings.mode == "manual" {
        return true;
    }
    auto_eligible(settings)
}

fn now_secs() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs() as i64)
        .unwrap_or(0)
}
