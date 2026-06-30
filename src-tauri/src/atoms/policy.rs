//! Stakes-tiered auto-approval policy + feedback-adaptive thresholds.

use rusqlite::Connection;

use super::AtomsSettings;

pub struct Thresholds {
    pub fact_conf: f64,
    pub fact_sub: f64,
}

/// Should this atom be auto-approved (skip the review queue)?
///
/// Stakes-tiered: Claims are the weakest/lowest-stakes unit (captured without
/// review); well-substantiated Facts are safe; Signals are minted already
/// corroborated. Interpretive / high-value kinds always go to review.
pub fn auto_decision(kind: &str, confidence: f64, substantiation: f64, thr: &Thresholds) -> bool {
    match kind {
        "claim" => true,
        "fact" => confidence >= thr.fact_conf && substantiation >= thr.fact_sub,
        "signal" => true,
        _ => false, // insight | decision | pain_point | action_item
    }
}

/// Base thresholds from settings, nudged by the user's feedback history.
pub fn effective_thresholds(conn: &Connection, settings: &AtomsSettings) -> Thresholds {
    let mut t = Thresholds {
        fact_conf: settings.fact_min_confidence,
        fact_sub: settings.fact_min_substantiation,
    };
    if !settings.adaptive {
        return t;
    }
    // Approval rate among *reviewed* facts (approve vs reject decisions).
    let (appr, rej): (i64, i64) = conn
        .query_row(
            "SELECT
               COALESCE(SUM(CASE WHEN decision='approve' THEN 1 ELSE 0 END), 0),
               COALESCE(SUM(CASE WHEN decision='reject'  THEN 1 ELSE 0 END), 0)
             FROM feedback WHERE kind='fact'",
            [],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .unwrap_or((0, 0));
    let n = appr + rej;
    if n >= 10 {
        let rate = appr as f64 / n as f64;
        if rate > 0.9 {
            // The user trusts facts → loosen so more auto-approve.
            t.fact_conf = (t.fact_conf - 0.1).max(0.5);
            t.fact_sub = (t.fact_sub - 0.1).max(0.5);
        } else if rate < 0.5 {
            // The user rejects many → tighten.
            t.fact_conf = (t.fact_conf + 0.1).min(0.95);
            t.fact_sub = (t.fact_sub + 0.1).min(0.95);
        }
    }
    t
}
