import { syntaxTree } from "@codemirror/language";
import { Decoration, DecorationSet, EditorView, WidgetType } from "@codemirror/view";
import { EditorState, Extension, Facet, Range, StateField } from "@codemirror/state";
import type { SyntaxNodeRef } from "@lezer/common";

/** Existing note names (lowercased file stems) for wikilink existence checks. */
export const noteNamesFacet = Facet.define<Set<string>, Set<string>>({
  combine: (values) => values[0] ?? new Set<string>(),
});

export type EditorMode = "source" | "live" | "reading";

/** Current editor mode. Source = no rendering; Live = reveal active line;
 *  Reading = render everything (no source revealed). */
export const editorModeFacet = Facet.define<EditorMode, EditorMode>({
  combine: (values) => values[0] ?? "live",
});

/** Callbacks the render rules may need from the host app. */
export interface RenderCallbacks {
  /** The vault-relative path of the note being edited (for Dataview `this`). */
  currentPath?: string;
  /** Follow a wikilink target (optionally to a heading/block). */
  onFollowLink: (name: string, anchor?: string) => void;
  /** Resolve an asset/embed target to a usable <img> src (async). */
  resolveAsset?: (target: string) => Promise<string | null>;
  /** Read a note's raw content for embeds (async). */
  readNote?: (path: string) => Promise<string>;
  /** Resolve a wikilink name to a vault path (async). */
  resolvePath?: (name: string) => Promise<string | null>;
}

/** Line numbers (1-based) touched by any cursor/selection — shown as raw source. */
export function activeLines(state: EditorState): Set<number> {
  const set = new Set<number>();
  for (const r of state.selection.ranges) {
    const a = state.doc.lineAt(r.from).number;
    const b = state.doc.lineAt(r.to).number;
    for (let l = a; l <= b; l++) set.add(l);
  }
  return set;
}

const hidden = Decoration.replace({});

/** Shared context passed to every render rule. */
export interface RenderCtx {
  state: EditorState;
  active: Set<number>;
  names: Set<string>;
  cb: RenderCallbacks;
  /** Add a mark/line decoration over [from,to] (skips empty/overlapping issues). */
  mark: (from: number, to: number, deco: Decoration) => void;
  /** Hide [from,to] (replace with nothing); skips if it overlaps a replaced range. */
  hide: (from: number, to: number) => void;
  /** Replace [from,to] with a widget; skips if it overlaps a replaced range. */
  replace: (from: number, to: number, widget: WidgetType, block?: boolean) => void;
  /** Insert a (non-replacing) widget at pos. */
  widget: (pos: number, widget: WidgetType, side?: number, block?: boolean) => void;
  /** Add a line decoration at the line containing pos. */
  line: (pos: number, deco: Decoration) => void;
  /** Is the line containing pos part of the active selection? */
  lineActive: (pos: number) => boolean;
  /** Does the selection touch any line within [from,to]? */
  rangeActive: (from: number, to: number) => boolean;
}

/** A rule that reacts to a syntax-tree node. */
export type NodeRule = (node: SyntaxNodeRef, ctx: RenderCtx) => void;
/** A rule that scans raw text (the whole document) for non-grammar tokens. */
export type RegexRule = (text: string, offset: number, ctx: RenderCtx) => void;

function overlaps(taken: [number, number][], from: number, to: number): boolean {
  for (const [s, e] of taken) if (s < to && e > from) return true;
  return false;
}

function build(
  state: EditorState,
  cb: RenderCallbacks,
  nodeRules: NodeRule[],
  regexRules: RegexRule[]
): DecorationSet {
  const mode = state.facet(editorModeFacet);
  if (mode === "source") return Decoration.none; // raw markdown, highlight only
  // Reading mode renders everything (nothing is "active"); Live reveals the
  // line(s) under the cursor/selection.
  const active = mode === "reading" ? new Set<number>() : activeLines(state);
  const names = state.facet(noteNamesFacet);
  const ranges: Range<Decoration>[] = [];
  const taken: [number, number][] = []; // replaced/widget ranges (no overlap allowed)

  const ctx: RenderCtx = {
    state,
    active,
    names,
    cb,
    mark: (from, to, deco) => {
      if (to > from) ranges.push(deco.range(from, to));
    },
    hide: (from, to) => {
      if (to > from && !overlaps(taken, from, to)) {
        taken.push([from, to]);
        ranges.push(hidden.range(from, to));
      }
    },
    replace: (from, to, widget, block) => {
      if (to >= from && !overlaps(taken, from, to)) {
        // Block decorations must span whole lines; otherwise fall back to inline.
        let useBlock = block;
        if (useBlock) {
          const ls = state.doc.lineAt(from);
          const le = state.doc.lineAt(to);
          if (ls.from !== from || le.to !== to) useBlock = false;
        }
        taken.push([from, to]);
        ranges.push(Decoration.replace({ widget, block: useBlock }).range(from, to));
      }
    },
    widget: (pos, widget, side = 1, block = false) => {
      ranges.push(Decoration.widget({ widget, side, block }).range(pos));
    },
    line: (pos, deco) => {
      const lineStart = state.doc.lineAt(pos).from;
      ranges.push(deco.range(lineStart));
    },
    lineActive: (pos) => active.has(state.doc.lineAt(pos).number),
    rangeActive: (from, to) => {
      const a = state.doc.lineAt(from).number;
      const b = state.doc.lineAt(Math.min(to, state.doc.length)).number;
      for (let l = a; l <= b; l++) if (active.has(l)) return true;
      return false;
    },
  };

  // Build over the whole document. Block widgets and line decorations must come
  // from a StateField (not a ViewPlugin), so we cannot use the viewport here.
  if (nodeRules.length) {
    syntaxTree(state).iterate({
      from: 0,
      to: state.doc.length,
      enter: (node) => {
        for (const rule of nodeRules) rule(node, ctx);
      },
    });
  }
  if (regexRules.length) {
    const text = state.doc.sliceString(0, state.doc.length);
    for (const rule of regexRules) rule(text, 0, ctx);
  }
  return Decoration.set(ranges, true);
}

/**
 * The live-preview render engine: a StateField that provides the decoration set.
 * A StateField (unlike a ViewPlugin) may supply block widgets and line
 * decorations, which we need for callouts, tables, math, embeds, etc.
 */
export function renderEngine(
  cb: RenderCallbacks,
  nodeRules: NodeRule[],
  regexRules: RegexRule[]
): Extension {
  const field = StateField.define<DecorationSet>({
    create(state) {
      return build(state, cb, nodeRules, regexRules);
    },
    update(value, tr) {
      // NOTE: deliberately not rebuilding on parser-progress transactions
      // (syntaxTree changes). Async widgets (mermaid/embeds) alter document
      // height → re-measure → re-parse, which would loop and recreate widgets.
      // The editor triggers a one-shot rebuild after mount instead.
      if (
        tr.docChanged ||
        tr.selection ||
        tr.startState.facet(noteNamesFacet) !== tr.state.facet(noteNamesFacet) ||
        tr.startState.facet(editorModeFacet) !== tr.state.facet(editorModeFacet)
      ) {
        return build(tr.state, cb, nodeRules, regexRules);
      }
      return value;
    },
    provide: (f) => EditorView.decorations.from(f),
  });
  return field;
}
