import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  autocompletion,
  CompletionContext,
  CompletionResult,
} from "@codemirror/autocomplete";
import { renderEngine, noteNamesFacet, type RenderCallbacks } from "./render/core";
import { nodeRules, regexRules } from "./render/rules";

export { noteNamesFacet };

/** Callbacks the editor needs from the host app. */
export interface EditorCallbacks extends RenderCallbacks {
  /** Provide current note names for wikilink autocomplete. */
  getNoteNames: () => string[];
}

/** Source-token styling. The render engine hides the markers on inactive lines. */
const markdownHighlight = HighlightStyle.define([
  { tag: t.heading1, class: "tok-h1" },
  { tag: t.heading2, class: "tok-h2" },
  { tag: t.heading3, class: "tok-h3" },
  { tag: [t.heading4, t.heading5, t.heading6], fontWeight: "600" },
  { tag: t.strong, fontWeight: "700" },
  { tag: t.emphasis, fontStyle: "italic" },
  { tag: t.strikethrough, textDecoration: "line-through" },
  { tag: t.link, color: "var(--onyx-accent)", textDecoration: "underline" },
  { tag: t.url, color: "var(--onyx-accent)" },
  { tag: t.monospace, class: "tok-code" },
  { tag: t.quote, fontStyle: "italic", opacity: "0.85" },
]);

/** Click handler: follow a `[[wikilink]]` (carrying an optional #heading/^block). */
function clickHandler(cb: EditorCallbacks): Extension {
  return EditorView.domEventHandlers({
    mousedown(event) {
      // Climb to the nearest element carrying the wikilink data — the click may
      // land on a nested span (syntax highlight) or an <a> inside a widget.
      const el = (event.target as HTMLElement)?.closest?.(
        "[data-wikilink]"
      ) as HTMLElement | null;
      const name = el?.getAttribute("data-wikilink");
      if (name) {
        event.preventDefault();
        cb.onFollowLink(name, el?.getAttribute("data-anchor") ?? undefined);
        return true;
      }
      return false;
    },
  });
}

/** Autocomplete for `[[` wikilinks. */
function wikilinkCompletion(cb: EditorCallbacks): Extension {
  const source = (context: CompletionContext): CompletionResult | null => {
    const before = context.matchBefore(/\[\[([^\]\n]*)$/);
    if (!before) return null;
    const typed = before.text.slice(2).toLowerCase();
    const options = cb
      .getNoteNames()
      .filter((n) => n.toLowerCase().includes(typed))
      .slice(0, 50)
      .map((n) => ({
        label: n,
        type: "text",
        // Only add the closing `]]` if closeBrackets hasn't already inserted one
        // (otherwise we'd produce `[[name]]]]`). Cursor lands after the brackets.
        apply: (view: EditorView, _c: unknown, from: number, to: number) => {
          const hasClose = view.state.sliceDoc(to, to + 2) === "]]";
          view.dispatch({
            changes: { from, to, insert: hasClose ? n : `${n}]]` },
            selection: { anchor: from + n.length + 2 },
          });
        },
      }));
    return { from: before.from + 2, options, validFor: /^[^\]\n]*$/ };
  };
  return autocompletion({ override: [source] });
}

/** All Onyx-specific editor extensions. */
export function onyxExtensions(cb: EditorCallbacks): Extension[] {
  return [
    syntaxHighlighting(markdownHighlight),
    renderEngine(cb, nodeRules, regexRules),
    clickHandler(cb),
    wikilinkCompletion(cb),
    EditorView.lineWrapping,
  ];
}
