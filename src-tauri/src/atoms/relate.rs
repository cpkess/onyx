//! Relationship inference between approved Atoms: cheap embedding-based
//! similar/related links, plus optional LLM-classified supports/contradicts/
//! extends, and used_in_decision links for decision atoms.

use rusqlite::params;
use tauri::AppHandle;

use crate::ai::{self, ChatMessage};

use super::{load_settings, now_secs, storage, with_atoms};

const KNN: usize = 8;
const RELATED_CUTOFF: f32 = 1.30;
const SIMILAR_CUTOFF: f32 = 0.90;
const LLM_CLASSIFY: usize = 3; // classify the N closest neighbors with the model

/// Build relationships for a freshly-approved atom. Best-effort; needs an embed
/// model for similarity and a chat model for typed relations.
pub async fn relate_atom(app: &AppHandle, atom_id: i64) {
    let cfg = ai::load_config(app);
    if cfg.embed_model.is_empty() {
        return;
    }
    let settings = load_settings(app);

    let Some((kind, text)) = with_atoms(app, |c| {
        c.query_row(
            "SELECT kind, text FROM atoms WHERE id=?1",
            [atom_id],
            |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)),
        )
    }) else {
        return;
    };

    // Always embed + store this atom's vector so it is retrievable by AI chat /
    // tools, regardless of whether relationship inference is enabled.
    let emb = match ai::embed(&cfg, vec![text.clone()]).await {
        Ok(v) => v.into_iter().next(),
        Err(_) => None,
    };
    let Some(vec) = emb else { return };
    let _ = with_atoms(app, |c| storage::upsert_atom_vec(c, atom_id, &vec));

    // Relationship inference is the expensive, optional part.
    if !settings.infer_relationships {
        return;
    }

    // Nearest approved atoms by embedding.
    let neighbors = with_atoms(app, |c| storage::search_atom_vec(c, &vec, KNN, atom_id))
        .unwrap_or_default();

    for (nid, dist) in neighbors.iter().take(6) {
        if *dist > RELATED_CUTOFF {
            continue;
        }
        let rel = if *dist < SIMILAR_CUTOFF { "similar_to" } else { "related_to" };
        add_relation(app, atom_id, *nid, rel, Some((1.0 - dist).max(0.0) as f64));
        // A decision draws on its nearest supporting atoms.
        if kind == "decision" {
            add_relation(app, *nid, atom_id, "used_in_decision", None);
        }
    }

    // LLM-classified typed relations for the closest neighbors.
    for (nid, _) in neighbors.iter().take(LLM_CLASSIFY) {
        let Some(ntext) = with_atoms(app, |c| {
            c.query_row("SELECT text FROM atoms WHERE id=?1", [nid], |r| r.get::<_, String>(0))
        }) else {
            continue;
        };
        if let Some(rel) = classify(&cfg, &text, &ntext).await {
            add_relation(app, atom_id, *nid, &rel, None);
        }
    }
}

/// Ask the model how atom A relates to atom B. Returns one of supports /
/// contradicts / extends, or None.
async fn classify(cfg: &ai::AiConfig, a: &str, b: &str) -> Option<String> {
    let messages = vec![
        ChatMessage {
            role: "system".into(),
            content: "Classify how statement A relates to statement B. Reply with ONE word only: \
                      supports, contradicts, extends, or none."
                .into(),
        },
        ChatMessage { role: "user".into(), content: format!("A: {a}\n\nB: {b}") },
    ];
    let out = ai::chat_complete(cfg, messages).await.ok()?;
    let w = out.to_lowercase();
    for r in ["contradicts", "supports", "extends"] {
        if w.contains(r) {
            return Some(r.to_string());
        }
    }
    None
}

fn add_relation(app: &AppHandle, from: i64, to: i64, kind: &str, confidence: Option<f64>) {
    if from == to {
        return;
    }
    let _ = with_atoms(app, |c| {
        let exists: i64 = c.query_row(
            "SELECT COUNT(*) FROM atom_relations WHERE from_id=?1 AND to_id=?2 AND kind=?3",
            params![from, to, kind],
            |r| r.get(0),
        )?;
        if exists == 0 {
            c.execute(
                "INSERT INTO atom_relations(from_id, to_id, kind, confidence, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5)",
                params![from, to, kind, confidence, now_secs()],
            )?;
        }
        Ok(())
    });
}
