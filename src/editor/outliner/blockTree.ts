import { Facet } from "@codemirror/state";
import type { EditorState, Line } from "@codemirror/state";

/**
 * Outliner block model: a *view over indented Markdown lines*. Files stay plain
 * Markdown on disk — this module only derives nesting/subtree structure from
 * leading whitespace so the keymap and fold service can operate on subtrees.
 * The width math mirrors the Rust `parse_blocks` indent model (tab = 2 spaces).
 */

/** One indent level, in spaces. Logseq-style two-space nesting. */
export const INDENT_UNIT = "  ";

/** Whether the block outliner keys/fold are active for this editor. */
export const outlinerFacet = Facet.define<boolean, boolean>({
  combine: (vs) => vs.some((v) => v),
});

/** A list item line: leading ws, marker, optional task box, content. */
const LIST_RE = /^(\s*)([-*+])(\s+)(\[[ xX]\]\s+)?(.*)$/;

/** Leading-whitespace width in spaces (tab counts as two, matching the index). */
export function indentWidth(text: string): number {
  let w = 0;
  for (const ch of text) {
    if (ch === " ") w += 1;
    else if (ch === "\t") w += 2;
    else break;
  }
  return w;
}

export interface ListInfo {
  /** Leading whitespace string (as written on disk). */
  ws: string;
  /** Marker character (`-`, `*`, or `+`). */
  marker: string;
  /** `true` when the item is a task (`- [ ]` / `- [x]`). */
  task: boolean;
  /** Column (into the line text) where the content begins. */
  contentCol: number;
  /** The content after the marker (and task box), block-id and all. */
  content: string;
}

/** Parse a line as a list item, or `null` if it isn't one. */
export function parseList(text: string): ListInfo | null {
  const m = LIST_RE.exec(text);
  if (!m) return null;
  const [, ws, marker, gap, taskBox = "", content] = m;
  return {
    ws,
    marker,
    task: taskBox.length > 0,
    contentCol: ws.length + marker.length + gap.length + taskBox.length,
    content,
  };
}

export function isListLine(text: string): boolean {
  return LIST_RE.test(text);
}

/**
 * The last line number (1-based, inclusive) of the outline subtree rooted at
 * `startLine`: the block itself plus every following more-indented line, with
 * interior blank lines absorbed only when deeper content follows.
 */
export function subtreeEnd(state: EditorState, startLine: number): number {
  const doc = state.doc;
  const rootIndent = indentWidth(doc.line(startLine).text);
  let end = startLine;
  let pendingBlanks = 0;
  for (let n = startLine + 1; n <= doc.lines; n++) {
    const text = doc.line(n).text;
    if (text.trim() === "") {
      pendingBlanks++;
      continue;
    }
    if (indentWidth(text) > rootIndent) {
      end = n;
      pendingBlanks = 0;
    } else {
      break;
    }
  }
  // Trailing blanks (pendingBlanks) are not part of the subtree.
  return end;
}

/**
 * The line number of the nearest previous sibling of `line` (same indent, not
 * separated by a shallower line), or `null` if `line` is the first child.
 */
export function previousSibling(state: EditorState, line: number): number | null {
  const doc = state.doc;
  const indent = indentWidth(doc.line(line).text);
  for (let n = line - 1; n >= 1; n--) {
    const text = doc.line(n).text;
    if (text.trim() === "") continue;
    const w = indentWidth(text);
    if (w < indent) return null; // hit the parent — no previous sibling
    if (w === indent && isListLine(text)) return n;
    // w > indent: part of a previous sibling's subtree — keep scanning up.
  }
  return null;
}

/** The [from, to] document offsets spanning the subtree rooted at `line`. */
export function subtreeRange(state: EditorState, line: Line): { from: number; to: number } {
  const endLine = subtreeEnd(state, line.number);
  return { from: line.from, to: state.doc.line(endLine).to };
}
