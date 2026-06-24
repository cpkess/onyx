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
