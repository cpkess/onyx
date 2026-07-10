import { EditorSelection, type ChangeSpec } from "@codemirror/state";
import { keymap } from "@codemirror/view";
import type { Command, KeyBinding } from "@codemirror/view";
import {
  INDENT_UNIT,
  indentWidth,
  isListLine,
  outlinerFacet,
  parseList,
  previousSibling,
  subtreeEnd,
} from "./blockTree";

/** Run `cmd` only when the outliner flag is on; otherwise fall through. */
function gated(cmd: Command): Command {
  return (view) => (view.state.facet(outlinerFacet) ? cmd(view) : false);
}

/** Indent the current list item and its whole subtree by one level. */
const indentBlock: Command = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  if (!isListLine(line.text)) return false; // let indentWithTab handle it
  // Can only indent when a previous sibling exists to become the new parent.
  if (previousSibling(state, line.number) === null) return true; // consume, no-op
  const endLine = subtreeEnd(state, line.number);
  const changes: ChangeSpec[] = [];
  for (let n = line.number; n <= endLine; n++) {
    const l = state.doc.line(n);
    if (l.text.trim() === "") continue;
    changes.push({ from: l.from, insert: INDENT_UNIT });
  }
  view.dispatch(state.update({ changes, userEvent: "input.indent" }));
  return true;
};

/** Outdent the current list item and its subtree by one level. */
const outdentBlock: Command = (view) => {
  const { state } = view;
  const line = state.doc.lineAt(state.selection.main.head);
  if (!isListLine(line.text)) return false;
  if (indentWidth(line.text) === 0) return true; // already at root — consume
  const endLine = subtreeEnd(state, line.number);
  const changes: ChangeSpec[] = [];
  for (let n = line.number; n <= endLine; n++) {
    const l = state.doc.line(n);
    // Strip one indent level: up to INDENT_UNIT spaces, or a single leading tab.
    let strip = 0;
    if (l.text.startsWith("\t")) strip = 1;
    else {
      while (strip < INDENT_UNIT.length && l.text[strip] === " ") strip++;
    }
    if (strip > 0) changes.push({ from: l.from, to: l.from + strip });
  }
  if (changes.length === 0) return true;
  view.dispatch(state.update({ changes, userEvent: "delete.dedent" }));
  return true;
};

/**
 * Enter on a list line: split into a new sibling bullet. Empty bullets outdent
 * (or fall through at the root so the user can exit the list).
 */
const splitBlock: Command = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const info = parseList(line.text);
  if (!info) return false;

  const contentStart = line.from + info.contentCol;
  const isEmpty = info.content.trim() === "";
  if (isEmpty) {
    // Empty bullet: outdent it, or leave the list entirely at the root.
    if (indentWidth(line.text) > 0) return outdentBlock(view);
    return false;
  }

  // New sibling carries the same indent + marker (never inherits the task box).
  const prefix = info.ws + info.marker + " ";
  const col = Math.max(sel.head, contentStart);
  const before = state.doc.sliceString(line.from, col);
  const after = state.doc.sliceString(col, line.to);
  const insert = before + "\n" + prefix + after;
  const caret = line.from + before.length + 1 + prefix.length;
  view.dispatch(
    state.update({
      changes: { from: line.from, to: line.to, insert },
      selection: EditorSelection.cursor(caret),
      userEvent: "input",
      scrollIntoView: true,
    })
  );
  return true;
};

/** Move the current subtree up or down past its sibling. */
function moveSubtree(dir: -1 | 1): Command {
  return (view) => {
    const { state } = view;
    const line = state.doc.lineAt(state.selection.main.head);
    if (!isListLine(line.text)) return false;
    const startN = line.number;
    const endN = subtreeEnd(state, startN);
    const blockFrom = state.doc.line(startN).from;
    const blockTo = state.doc.line(endN).to;
    const block = state.doc.sliceString(blockFrom, blockTo);
    const indent = indentWidth(line.text);

    if (dir === -1) {
      // Find the previous sibling and move the block above it.
      const sib = previousSibling(state, startN);
      if (sib === null) return true;
      const sibFrom = state.doc.line(sib).from;
      view.dispatch(
        state.update({
          changes: [
            // Remove the block plus its leading newline (safe when it's last).
            { from: blockFrom - 1, to: blockTo, insert: "" },
            { from: sibFrom, insert: block + "\n" },
          ],
          selection: EditorSelection.cursor(
            sibFrom + (state.selection.main.head - blockFrom)
          ),
          userEvent: "move.line",
          scrollIntoView: true,
        })
      );
      return true;
    } else {
      // Find the next sibling (first following line at the same indent).
      let next: number | null = null;
      for (let n = endN + 1; n <= state.doc.lines; n++) {
        const t = state.doc.line(n).text;
        if (t.trim() === "") continue;
        const w = indentWidth(t);
        if (w < indent) break;
        if (w === indent && isListLine(t)) {
          next = n;
          break;
        }
        break;
      }
      if (next === null) return true;
      const nextEnd = subtreeEnd(state, next);
      const nextFrom = state.doc.line(next).from;
      const nextTo = state.doc.line(nextEnd).to;
      const nextBlock = state.doc.sliceString(nextFrom, nextTo);
      // Swap the two sibling blocks.
      view.dispatch(
        state.update({
          changes: {
            from: blockFrom,
            to: nextTo,
            insert: nextBlock + "\n" + block,
          },
          selection: EditorSelection.cursor(
            blockFrom +
              nextBlock.length +
              1 +
              (state.selection.main.head - blockFrom)
          ),
          userEvent: "move.line",
          scrollIntoView: true,
        })
      );
      return true;
    }
  };
}

/** Backspace at the start of a bullet's content: outdent (or merge at root). */
const backspaceOutdent: Command = (view) => {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const line = state.doc.lineAt(sel.head);
  const info = parseList(line.text);
  if (!info) return false;
  if (sel.head !== line.from + info.contentCol) return false; // only at content start
  if (indentWidth(line.text) > 0) return outdentBlock(view);
  return false; // at root — let default backspace merge lines
};

export const outlinerKeymap: KeyBinding[] = [
  { key: "Tab", run: gated(indentBlock) },
  { key: "Shift-Tab", run: gated(outdentBlock) },
  { key: "Enter", run: gated(splitBlock) },
  { key: "Backspace", run: gated(backspaceOutdent) },
  { key: "Mod-Shift-ArrowUp", run: gated(moveSubtree(-1)) },
  { key: "Mod-Shift-ArrowDown", run: gated(moveSubtree(1)) },
];

/** The outliner keymap, to be installed *before* the default keymap. */
export const outlinerKeys = keymap.of(outlinerKeymap);
