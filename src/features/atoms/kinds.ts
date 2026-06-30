// Canonical Atom kind → label mapping, shared across the Atoms UI surfaces.

export const KIND_LABEL: Record<string, string> = {
  fact: "Fact",
  signal: "Signal",
  insight: "Insight",
  pain_point: "Pain Point",
  claim: "Claim",
  action_item: "Action",
  decision: "Decision",
};

export const ATOM_KINDS = Object.keys(KIND_LABEL);

/** A color per kind, used for badges and graph nodes. */
export const KIND_COLOR: Record<string, string> = {
  fact: "#4c8dff",
  signal: "#16a394",
  insight: "#7c6cff",
  pain_point: "#e0524c",
  claim: "#e0a800",
  action_item: "#2ecc71",
  decision: "#d6336c",
};

export function kindLabel(kind: string): string {
  return KIND_LABEL[kind] ?? kind;
}
