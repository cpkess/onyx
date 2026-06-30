//! Statistical Signals: when the same observation recurs across multiple
//! sources, promote the cluster into a single corroborated **Signal** atom.
//! Signals are derived here, not labeled per-chunk by the model.

use rusqlite::params;
use std::collections::HashSet;
use tauri::AppHandle;

use crate::ai;

use super::{load_settings, now_secs, relate, storage, with_atoms};

/// Cosine-similarity threshold for two atoms to be "the same observation".
const SIM: f32 = 0.86;
/// Bound the O(n²) clustering.
const MAX_CANDIDATES: usize = 600;

struct Cand {
    id: i64,
    text: String,
    source: String,
    sub: f64,
    status: String,
}

pub async fn detect(app: &AppHandle) {
    let settings = load_settings(app);
    let min_sources = settings.signal_min_sources.max(2) as usize;

    let cfg = ai::load_config(app);
    if cfg.embed_model.is_empty() {
        return;
    }

    let cands: Vec<Cand> = with_atoms(app, |c| {
        let mut s = c.prepare(
            "SELECT id, text, source_path, substantiation, status FROM atoms
             WHERE kind != 'signal' AND status IN ('approved','pending')
             ORDER BY id DESC LIMIT ?1",
        )?;
        let rows = s
            .query_map([MAX_CANDIDATES as i64], |r| {
                Ok(Cand {
                    id: r.get(0)?,
                    text: r.get(1)?,
                    source: r.get(2)?,
                    sub: r.get::<_, Option<f64>>(3)?.unwrap_or(0.5),
                    status: r.get(4)?,
                })
            })?
            .filter_map(|x| x.ok())
            .collect();
        Ok(rows)
    })
    .unwrap_or_default();
    if cands.len() < min_sources {
        return;
    }

    // Embed all candidate texts (batched).
    let mut vecs: Vec<Vec<f32>> = Vec::with_capacity(cands.len());
    for batch in cands.chunks(32) {
        let inputs: Vec<String> = batch.iter().map(|c| c.text.clone()).collect();
        match ai::embed(&cfg, inputs).await {
            Ok(mut v) => vecs.append(&mut v),
            Err(_) => return,
        }
    }
    if vecs.len() != cands.len() {
        return;
    }

    // Greedy clustering by cosine similarity.
    let mut used: HashSet<usize> = HashSet::new();
    for i in 0..cands.len() {
        if used.contains(&i) {
            continue;
        }
        let mut cluster = vec![i];
        for j in (i + 1)..cands.len() {
            if used.contains(&j) {
                continue;
            }
            if cosine(&vecs[i], &vecs[j]) >= SIM {
                cluster.push(j);
            }
        }
        let sources: HashSet<&str> = cluster.iter().map(|&k| cands[k].source.as_str()).collect();
        if sources.len() < min_sources {
            continue;
        }
        for &k in &cluster {
            used.insert(k);
        }
        mint_signal(app, &cands, &cluster).await;
    }
}

async fn mint_signal(app: &AppHandle, cands: &[Cand], cluster: &[usize]) {
    // Representative = highest-substantiation member.
    let rep = *cluster
        .iter()
        .max_by(|&&a, &&b| cands[a].sub.partial_cmp(&cands[b].sub).unwrap())
        .unwrap();
    let text = cands[rep].text.clone();
    let source = cands[rep].source.clone();
    let sub = cluster.iter().map(|&k| cands[k].sub).fold(0.0, f64::max);
    let sig = storage::signature("signal", &text);

    let signal_id = with_atoms(app, |c| {
        let exists: i64 = c.query_row(
            "SELECT COUNT(*) FROM atoms WHERE signature=?1 AND kind='signal'",
            [&sig],
            |r| r.get(0),
        )?;
        if exists > 0 {
            return Ok(0i64);
        }
        let now = now_secs();
        c.execute(
            "INSERT INTO atoms(kind, text, source_path, confidence, substantiation, status,
                               auto_approved, signature, created_at, updated_at)
             VALUES ('signal', ?1, ?2, 0.9, ?3, 'approved', 1, ?4, ?5, ?5)",
            params![text, source, sub, sig, now],
        )?;
        let sid = c.last_insert_rowid();
        for &k in cluster {
            let member = cands[k].id;
            c.execute(
                "INSERT INTO atom_relations(from_id, to_id, kind, created_at) VALUES (?1, ?2, 'instance_of', ?3)",
                params![member, sid, now],
            )?;
            // Corroboration auto-approves still-pending members.
            if cands[k].status == "pending" {
                c.execute(
                    "UPDATE atoms SET status='approved', auto_approved=1, updated_at=?2 WHERE id=?1",
                    params![member, now],
                )?;
            }
        }
        Ok(sid)
    })
    .unwrap_or(0);

    if signal_id > 0 {
        relate::relate_atom(app, signal_id).await; // embed so it's retrievable
    }
}

fn cosine(a: &[f32], b: &[f32]) -> f32 {
    let mut dot = 0.0;
    let mut na = 0.0;
    let mut nb = 0.0;
    for i in 0..a.len().min(b.len()) {
        dot += a[i] * b[i];
        na += a[i] * a[i];
        nb += b[i] * b[i];
    }
    if na == 0.0 || nb == 0.0 {
        return 0.0;
    }
    dot / (na.sqrt() * nb.sqrt())
}
