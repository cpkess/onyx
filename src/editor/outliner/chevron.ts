import { Decoration, EditorView, WidgetType } from "@codemirror/view";
import type { DecorationSet } from "@codemirror/view";
import { StateField } from "@codemirror/state";
import type { EditorState } from "@codemirror/state";
import { foldEffect, foldedRanges, unfoldEffect } from "@codemirror/language";
import { indentWidth, isListLine, outlinerFacet, parseList, subtreeEnd } from "./blockTree";

/** The folded range starting at this list line (line.to), if it's collapsed. */
function foldedAt(state: EditorState, lineTo: number): { from: number; to: number } | null {
  let hit: { from: number; to: number } | null = null;
  foldedRanges(state).between(lineTo, lineTo, (from, to) => {
    if (from === lineTo) hit = { from, to };
  });
  return hit;
}

class ChevronWidget extends WidgetType {
  constructor(private collapsed: boolean, private range: { from: number; to: number }) {
    super();
  }
  eq(other: ChevronWidget) {
    return (
      this.collapsed === other.collapsed &&
      this.range.from === other.range.from &&
      this.range.to === other.range.to
    );
  }
  toDOM(view: EditorView) {
    const el = document.createElement("span");
    el.className = "onyx-fold-chevron" + (this.collapsed ? " collapsed" : "");
    el.textContent = this.collapsed ? "▸" : "▾";
    el.title = this.collapsed ? "Expand" : "Collapse";
    el.onmousedown = (e) => {
      e.preventDefault();
      view.dispatch({
        effects: (this.collapsed ? unfoldEffect : foldEffect).of(this.range),
      });
    };
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

function build(state: EditorState): DecorationSet {
  if (!state.facet(outlinerFacet)) return Decoration.none;
  const ranges = [];
  for (let n = 1; n <= state.doc.lines; n++) {
    const line = state.doc.line(n);
    if (!isListLine(line.text)) continue;
    const endLine = subtreeEnd(state, n);
    if (endLine <= n) continue; // no children — no chevron
    const foldRange = { from: line.to, to: state.doc.line(endLine).to };
    const folded = foldedAt(state, line.to);
    const info = parseList(line.text);
    const pos = line.from + (info ? info.ws.length : indentWidth(line.text));
    ranges.push(
      Decoration.widget({
        widget: new ChevronWidget(folded !== null, folded ?? foldRange),
        side: -1,
      }).range(pos)
    );
  }
  return Decoration.set(ranges, true);
}

/** Renders a ▾/▸ collapse toggle just left of any bullet that has children. */
export const foldChevrons = StateField.define<DecorationSet>({
  create: (state) => build(state),
  update(value, tr) {
    const foldChanged = tr.effects.some((e) => e.is(foldEffect) || e.is(unfoldEffect));
    if (
      tr.docChanged ||
      foldChanged ||
      tr.startState.facet(outlinerFacet) !== tr.state.facet(outlinerFacet)
    ) {
      return build(tr.state);
    }
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});
