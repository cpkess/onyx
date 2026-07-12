export interface Prop {
  key: string;
  value: string;
}

export interface ParsedFrontmatter {
  props: Prop[];
  /** Offset just past the closing `---` line (0 if there is no frontmatter). */
  end: number;
  has: boolean;
}

/**
 * Parse a leading `---\n…\n---` YAML frontmatter block into ordered key/value
 * pairs. Values keep their raw text (quotes stripped for display); nested/list
 * YAML is flattened line-by-line (good enough for the simple key/value editor).
 */
export function parseFrontmatter(content: string): ParsedFrontmatter {
  const m = content.match(/^---\n([\s\S]*?)\n---[ \t]*(?:\n|$)/);
  if (!m) return { props: [], end: 0, has: false };
  const props: Prop[] = [];
  for (const line of m[1].split("\n")) {
    if (!line.trim()) continue;
    const i = line.indexOf(":");
    if (i === -1) {
      props.push({ key: line.trim(), value: "" });
    } else {
      props.push({ key: line.slice(0, i).trim(), value: stripQuotes(line.slice(i + 1).trim()) });
    }
  }
  return { props, end: m[0].length, has: true };
}

function stripQuotes(s: string): string {
  const t = s.trim();
  if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
    return t.slice(1, -1);
  }
  return t;
}

/** Whether a scalar value must be quoted to survive a YAML round-trip. */
function needsQuotes(v: string): boolean {
  if (v === "") return false;
  if (/^[\s]|[\s]$/.test(v)) return true; // leading/trailing space
  return /[:#\[\]{}",]|^[@!&*?|>%'"`-]/.test(v);
}

function quoteValue(v: string): string {
  if (!needsQuotes(v)) return v;
  return `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/**
 * Serialize ordered props into a `---\n…\n---\n` block (empty string if there
 * are no non-empty-keyed props). Rows with a blank key are dropped.
 */
export function serializeFrontmatter(props: Prop[]): string {
  const rows = props
    .filter((p) => p.key.trim())
    .map((p) => `${p.key.trim()}: ${quoteValue(p.value)}`.trimEnd());
  if (rows.length === 0) return "";
  return `---\n${rows.join("\n")}\n---\n`;
}

/**
 * Replace the note's frontmatter block with one built from `props` (prepending
 * a block if none exists, or dropping the block when `props` is empty).
 */
export function applyFrontmatter(content: string, props: Prop[]): string {
  const { end, has } = parseFrontmatter(content);
  const body = has ? content.slice(end) : content;
  const block = serializeFrontmatter(props);
  if (!block) return body.replace(/^\n+/, ""); // no props → strip a leading blank
  // Ensure exactly one newline between the block and the body.
  return block + (body.startsWith("\n") || body === "" ? body : "\n" + body);
}
