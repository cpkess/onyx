import { EditorView } from "@codemirror/view";

/**
 * Tracks the currently focused note editor so AI panels can insert text into
 * the live buffer (keeping the editor authoritative; autosave persists it).
 */
let active: EditorView | null = null;
let activePath: string | null = null;

export function setActiveEditor(view: EditorView | null, path?: string | null) {
  active = view;
  if (path !== undefined) activePath = path;
}

export function clearActiveEditor(view: EditorView) {
  if (active === view) {
    active = null;
    activePath = null;
  }
}

export function hasActiveEditor(): boolean {
  return active !== null;
}

export function getActiveEditor(): EditorView | null {
  return active;
}

/** Path of the note currently in the active editor, if known. */
export function getActiveEditorPath(): string | null {
  return activePath;
}

/**
 * Replace the whole document of the active editor, but only if it's showing
 * `path`. Returns true if it replaced (which triggers autosave + reindex).
 */
export function replaceActiveDoc(path: string, content: string): boolean {
  if (!active || activePath !== path) return false;
  active.dispatch({
    changes: { from: 0, to: active.state.doc.length, insert: content },
  });
  return true;
}

/** Scroll the active editor to a heading by its text. */
export function scrollToHeading(text: string): boolean {
  if (!active) return false;
  const doc = active.state.doc;
  const target = text.trim().toLowerCase();
  for (let i = 1; i <= doc.lines; i++) {
    const m = doc.line(i).text.match(/^#{1,6}\s+(.*)$/);
    if (m && m[1].trim().toLowerCase() === target) {
      const pos = doc.line(i).from;
      active.dispatch({
        selection: { anchor: pos },
        effects: EditorView.scrollIntoView(pos, { y: "start" }),
      });
      active.focus();
      return true;
    }
  }
  return false;
}

/**
 * Insert an `<!--ai … -->` HCM block under the nearest heading at/above the
 * cursor (or at the cursor if there's no heading), placing the cursor on the
 * empty instruction line. Returns false if there's no active editor.
 */
export function insertHcmBlock(): boolean {
  if (!active) return false;
  const doc = active.state.doc;
  const cursorLine = doc.lineAt(active.state.selection.main.head).number;
  // Walk up to the nearest heading line.
  let headingLine = 0;
  for (let i = cursorLine; i >= 1; i--) {
    if (/^#{1,6}\s+/.test(doc.line(i).text)) {
      headingLine = i;
      break;
    }
  }
  const insertAt = headingLine ? doc.line(headingLine).to : doc.line(cursorLine).to;
  const block = "\n<!--ai\n\n-->";
  active.dispatch({
    changes: { from: insertAt, insert: block },
    // Cursor on the empty middle line: after "\n<!--ai\n".
    selection: { anchor: insertAt + 8 },
  });
  active.focus();
  return true;
}

/**
 * Wrap the current selection in `before`/`after` markers, toggling them off if
 * they're already present. With an empty selection, insert the markers and place
 * the caret between them. Used for bold/italic/strikethrough/code/highlight.
 */
export function wrapSelection(before: string, after = before): boolean {
  if (!active) return false;
  const { from, to } = active.state.selection.main;
  const doc = active.state.doc;
  const sel = doc.sliceString(from, to);

  // Already wrapped inside the selection? → unwrap.
  if (sel.length >= before.length + after.length && sel.startsWith(before) && sel.endsWith(after)) {
    const inner = sel.slice(before.length, sel.length - after.length);
    active.dispatch({
      changes: { from, to, insert: inner },
      selection: { anchor: from, head: from + inner.length },
    });
    active.focus();
    return true;
  }
  // Markers sit just outside the selection? → unwrap those.
  const outBefore = doc.sliceString(Math.max(0, from - before.length), from);
  const outAfter = doc.sliceString(to, Math.min(doc.length, to + after.length));
  if (outBefore === before && outAfter === after) {
    active.dispatch({
      changes: [
        { from: from - before.length, to, insert: sel },
        { from: to, to: to + after.length, insert: "" },
      ],
      selection: { anchor: from - before.length, head: to - before.length },
    });
    active.focus();
    return true;
  }
  // Otherwise wrap.
  active.dispatch({
    changes: [
      { from, insert: before },
      { from: to, insert: after },
    ],
    selection:
      from === to
        ? { anchor: from + before.length }
        : { anchor: from + before.length, head: to + before.length },
  });
  active.focus();
  return true;
}

/**
 * Add `prefix` to every line spanned by the selection, or remove it if all those
 * lines already have it (toggle). Used for quote/bullet/numbered/task lines.
 */
export function toggleLinePrefix(prefix: string): boolean {
  if (!active) return false;
  const doc = active.state.doc;
  const { from, to } = active.state.selection.main;
  const first = doc.lineAt(from).number;
  const last = doc.lineAt(to).number;
  const lines = [];
  for (let i = first; i <= last; i++) lines.push(doc.line(i));

  const all = lines.every((l) => l.text.startsWith(prefix));
  const changes = lines.map((l) =>
    all
      ? { from: l.from, to: l.from + prefix.length, insert: "" }
      : { from: l.from, insert: prefix }
  );
  active.dispatch({ changes });
  active.focus();
  return true;
}

/**
 * Set the current line to a heading of `level` (1–3), replacing any existing
 * heading marker. If it's already that level, strip it back to body text.
 */
export function cycleHeading(level: 1 | 2 | 3): boolean {
  if (!active) return false;
  const doc = active.state.doc;
  const line = doc.lineAt(active.state.selection.main.head);
  const m = line.text.match(/^(#{1,6})\s+/);
  const want = "#".repeat(level) + " ";
  let insert: string;
  let removeLen: number;
  if (m) {
    removeLen = m[0].length;
    insert = m[1].length === level ? "" : want; // same level → toggle off
  } else {
    removeLen = 0;
    insert = want;
  }
  active.dispatch({ changes: { from: line.from, to: line.from + removeLen, insert } });
  active.focus();
  return true;
}

/**
 * Insert `text` at the cursor; if `caret` is given, place the caret at
 * `cursor + caret` (e.g. inside `[[]]`). Returns false if no editor.
 */
export function insertSnippet(text: string, caret?: number): boolean {
  if (!active) return false;
  const pos = active.state.selection.main.head;
  active.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + (caret ?? text.length) },
  });
  active.focus();
  return true;
}

/** Insert text at the cursor (or end if unfocused). Returns false if no editor. */
export function insertText(text: string): boolean {
  if (!active) return false;
  const pos = active.state.selection.main.head;
  active.dispatch({
    changes: { from: pos, insert: text },
    selection: { anchor: pos + text.length },
  });
  active.focus();
  return true;
}

/** Append inline `#tags` on a fresh line at the end of the note. */
export function appendTags(tags: string[]): boolean {
  if (!active || tags.length === 0) return false;
  const doc = active.state.doc;
  const line = tags.map((t) => `#${t.replace(/^#/, "")}`).join(" ");
  const content = doc.toString();
  const prefix = content.length === 0 ? "" : content.endsWith("\n") ? "\n" : "\n\n";
  active.dispatch({
    changes: { from: doc.length, insert: `${prefix}${line}\n` },
  });
  active.focus();
  return true;
}
