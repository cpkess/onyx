import {
  Decoration,
  EditorView,
  WidgetType,
  keymap,
} from "@codemirror/view";
import type { Command, DecorationSet, KeyBinding } from "@codemirror/view";
import {
  EditorSelection,
  EditorState,
  StateEffect,
  StateField,
} from "@codemirror/state";
import { indentWidth, isListLine, outlinerFacet, parseList, subtreeEnd } from "./blockTree";

/** Set (or clear, with `null`) the zoomed-in subtree range. */
export const setZoom = StateEffect.define<{ from: number; to: number } | null>();

interface ZoomRange {
  from: number;
  to: number;
}

/** The currently hoisted subtree, remapped across edits. */
export const zoomField = StateField.define<ZoomRange | null>({
  create: () => null,
  update(value, tr) {
    for (const e of tr.effects) if (e.is(setZoom)) return e.value;
    if (value && tr.docChanged) {
      const from = tr.changes.mapPos(value.from, 1);
      const to = tr.changes.mapPos(value.to, -1);
      return to > from ? { from, to } : null;
    }
    return value;
  },
  provide: (f) =>
    EditorView.decorations.compute([f, "doc", outlinerFacet], (state) =>
      zoomDecorations(state)
    ),
});

interface Segment {
  text: string;
  from: number;
  to: number;
}

/** The ancestor bullets above `rootLine`, outermost first (for the breadcrumb). */
function ancestorSegments(state: EditorState, rootLine: number): Segment[] {
  const segs: Segment[] = [];
  let curIndent = indentWidth(state.doc.line(rootLine).text);
  for (let n = rootLine - 1; n >= 1 && curIndent > 0; n--) {
    const text = state.doc.line(n).text;
    if (text.trim() === "") continue;
    const w = indentWidth(text);
    if (w < curIndent && isListLine(text)) {
      const info = parseList(text);
      const end = subtreeEnd(state, n);
      segs.unshift({
        text: (info?.content ?? text.trim()).slice(0, 60),
        from: state.doc.line(n).from,
        to: state.doc.line(end).to,
      });
      curIndent = w;
    }
  }
  return segs;
}

class BreadcrumbWidget extends WidgetType {
  constructor(private segs: Segment[]) {
    super();
  }
  eq(other: BreadcrumbWidget) {
    return (
      this.segs.length === other.segs.length &&
      this.segs.every((s, i) => s.text === other.segs[i].text)
    );
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("div");
    wrap.className = "onyx-zoom-breadcrumb";
    const home = document.createElement("button");
    home.className = "onyx-zoom-crumb onyx-zoom-home";
    home.textContent = "⌂";
    home.title = "Exit zoom (Esc)";
    home.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({ effects: setZoom.of(null) });
    };
    wrap.appendChild(home);
    for (const seg of this.segs) {
      const sep = document.createElement("span");
      sep.className = "onyx-zoom-sep";
      sep.textContent = "›";
      wrap.appendChild(sep);
      const crumb = document.createElement("button");
      crumb.className = "onyx-zoom-crumb";
      crumb.textContent = seg.text || "•";
      crumb.onmousedown = (e) => {
        e.preventDefault();
        view.dispatch({ effects: setZoom.of({ from: seg.from, to: seg.to }) });
      };
      wrap.appendChild(crumb);
    }
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

const hide = Decoration.replace({});

function zoomDecorations(state: EditorState): DecorationSet {
  const z = state.field(zoomField, false);
  if (!z || !state.facet(outlinerFacet)) return Decoration.none;
  const from = Math.max(0, Math.min(z.from, state.doc.length));
  const to = Math.max(from, Math.min(z.to, state.doc.length));
  const rootLine = state.doc.lineAt(from).number;
  const ranges = [];
  if (from > 0) ranges.push(hide.range(0, from));
  ranges.push(
    Decoration.widget({
      widget: new BreadcrumbWidget(ancestorSegments(state, rootLine)),
      block: true,
      side: -1,
    }).range(from)
  );
  if (to < state.doc.length) ranges.push(hide.range(to, state.doc.length));
  return Decoration.set(ranges, true);
}

/** Keep the selection inside the zoomed subtree. */
const clampSelection = EditorState.transactionFilter.of((tr) => {
  const z = tr.state.field(zoomField, false);
  if (!z || !tr.selection) return tr;
  const clamp = (p: number) => Math.max(z.from, Math.min(z.to, p));
  const ranges = tr.newSelection.ranges.map((r) =>
    EditorSelection.range(clamp(r.anchor), clamp(r.head))
  );
  return [tr, { selection: EditorSelection.create(ranges, tr.newSelection.mainIndex) }];
});

const zoomIn: Command = (view) => {
  if (!view.state.facet(outlinerFacet)) return false;
  const line = view.state.doc.lineAt(view.state.selection.main.head);
  if (!isListLine(line.text)) return false;
  const endLine = subtreeEnd(view.state, line.number);
  const to = view.state.doc.line(endLine).to;
  view.dispatch({ effects: setZoom.of({ from: line.from, to }) });
  return true;
};

const zoomOut: Command = (view) => {
  if (!view.state.field(zoomField, false)) return false;
  view.dispatch({ effects: setZoom.of(null) });
  return true;
};

/** Plain click on a bullet zooms into that subtree (Logseq behavior). */
const zoomOnBulletClick = EditorView.domEventHandlers({
  mousedown(e, view) {
    if (!view.state.facet(outlinerFacet)) return false;
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return false;
    const target = e.target as HTMLElement | null;
    if (!target?.closest(".onyx-bullet")) return false;
    const pos = view.posAtDOM(target);
    const line = view.state.doc.lineAt(pos);
    if (!isListLine(line.text)) return false;
    const endLine = subtreeEnd(view.state, line.number);
    const to = view.state.doc.line(endLine).to;
    e.preventDefault();
    view.dispatch({ effects: setZoom.of({ from: line.from, to }) });
    return true;
  },
});

export const zoomKeymap: KeyBinding[] = [
  { key: "Mod-.", run: zoomIn },
  { key: "Mod-,", run: zoomOut },
  { key: "Escape", run: zoomOut },
];

export const zoomExtension = [
  zoomField,
  clampSelection,
  zoomOnBulletClick,
  keymap.of(zoomKeymap),
];
