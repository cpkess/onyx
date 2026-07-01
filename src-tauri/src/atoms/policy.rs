//! Auto-approval policy: a single, user-adjustable confidence threshold.

/// Auto-approve (skip review) any atom whose confidence meets the threshold,
/// regardless of kind. The threshold is set in Settings → Atoms.
pub fn auto_decision(confidence: f64, threshold: f64) -> bool {
    confidence >= threshold
}
