// Per-table conditional badge formatting for Dataview TABLE cells.
//
// Config is carried inside the ```dataview fence as a single sentinel comment
// line (`%% onyx-badges: {json} %%`) that is stripped before the DQL parser
// runs, so query parsing is never affected. Keyed by lowercased column header.

/** Curated named palette → hex. Rendered as a tinted pill (see .onyx-dv-badge). */
export const BADGE_COLORS: Record<string, string> = {
  gray: "#8a8f98",
  red: "#e0524c",
  orange: "#e8833a",
  amber: "#e0a800",
  green: "#2ecc71",
  teal: "#16a394",
  blue: "#4c8dff",
  purple: "#7c6cff",
  pink: "#d6336c",
};

export const BADGE_COLOR_NAMES = Object.keys(BADGE_COLORS);

export interface BadgeRule {
  value: string; // status value to match (case-insensitive)
  color: string; // a BADGE_COLORS key (falls back to a raw hex if unknown)
}

/** Column header (lowercased) → its badge rules. */
export type BadgeFormat = Record<string, BadgeRule[]>;

const SENTINEL = /^\s*%%\s*onyx-badges:\s*(.*?)\s*%%\s*$/;

/** Resolve a rule's color to a hex string (named palette, else the raw value). */
export function badgeColorHex(color: string): string {
  return BADGE_COLORS[color] ?? color;
}

/** Serialize a format to the sentinel line, or "" when there are no rules. */
export function serializeBadgeFormat(fmt: BadgeFormat): string {
  const entries = Object.entries(fmt).filter(([, rules]) => rules.length > 0);
  if (entries.length === 0) return "";
  return `%% onyx-badges: ${JSON.stringify(Object.fromEntries(entries))} %%`;
}

/** Parse the sentinel line out of a block body; null if absent or malformed. */
export function parseBadgeFormat(text: string): BadgeFormat | null {
  for (const line of text.split("\n")) {
    const m = line.match(SENTINEL);
    if (!m) continue;
    try {
      const obj = JSON.parse(m[1]) as unknown;
      if (obj && typeof obj === "object") return obj as BadgeFormat;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * Split a ```dataview fence body into the clean DQL (sentinel lines removed) and
 * the parsed badge format (null when there is none).
 */
export function splitDataviewSource(body: string): { dql: string; format: BadgeFormat | null } {
  const format = parseBadgeFormat(body);
  const dql = body
    .split("\n")
    .filter((l) => !SENTINEL.test(l))
    .join("\n");
  return { dql, format };
}

/**
 * Return the hex color for a cell if a rule matches, else null. Matches by
 * column header (case-insensitive) then by value (case-insensitive).
 */
export function matchBadge(
  format: BadgeFormat | null | undefined,
  header: string | undefined,
  value: string
): string | null {
  if (!format || !header) return null;
  const rules = format[header.toLowerCase()];
  if (!rules) return null;
  const v = value.trim().toLowerCase();
  const hit = rules.find((r) => r.value.trim().toLowerCase() === v);
  return hit ? badgeColorHex(hit.color) : null;
}
