import { EditorView } from "@codemirror/view";
import { Extension } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import {
  autocompletion,
  CompletionContext,
  CompletionResult,
  type Completion,
  type CompletionSource,
} from "@codemirror/autocomplete";
import { renderEngine, noteNamesFacet, type RenderCallbacks } from "./render/core";
import { nodeRules, regexRules } from "./render/rules";
import { getCachedPages } from "../dataview/pages";
import { escapeRegExp, notesInCategory } from "../lib/categories";
import type { Category } from "../settings";

export { noteNamesFacet };

/** Callbacks the editor needs from the host app. */
export interface EditorCallbacks extends RenderCallbacks {
  /** Provide current note names for wikilink autocomplete. */
  getNoteNames: () => string[];
  /** Current note categories (for typed-link triggers like `@`). */
  getCategories: () => Category[];
  /** Create a categorized note in the background (typed-link create-on-miss). */
  createCategoryNote: (id: string, name: string) => void;
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

/** Autocomplete source for `[[` wikilinks. */
function wikilinkSource(cb: EditorCallbacks): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
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
        apply: (view: EditorView, _c: Completion, from: number, to: number) => {
          const hasClose = view.state.sliceDoc(to, to + 2) === "]]";
          view.dispatch({
            changes: { from, to, insert: hasClose ? n : `${n}]]` },
            selection: { anchor: from + n.length + 2 },
          });
        },
      }));
    return { from: before.from + 2, options, validFor: /^[^\]\n]*$/ };
  };
}

/** Replace [from,to] with a `[[name]]` wikilink, cursor after the brackets. */
function insertWikilink(view: EditorView, from: number, to: number, name: string) {
  view.dispatch({
    changes: { from, to, insert: `[[${name}]]` },
    selection: { anchor: from + name.length + 4 },
  });
}

/**
 * Typed-link triggers: a single source that, at query time, checks each
 * configured category's trigger char (e.g. `@`, `+`) at the cursor. On a match
 * it offers that category's notes; selecting one inserts a plain `[[Name]]`.
 * A "Create …" option makes the note in the category folder + `type:` field.
 */
function categorySource(cb: EditorCallbacks): CompletionSource {
  return (context: CompletionContext): CompletionResult | null => {
    for (const cat of cb.getCategories()) {
      if (!cat.trigger) continue;
      // trigger, then either a word-ish run (allowing inner spaces) or nothing.
      const re = new RegExp(escapeRegExp(cat.trigger) + "([\\w.'-][\\w .'-]*|)$");
      const before = context.matchBefore(re);
      if (!before) continue;
      // Require a word boundary before the trigger (so "email@x" / "a+b" skip).
      if (before.from > 0 && !/\s/.test(context.state.sliceDoc(before.from - 1, before.from))) {
        continue;
      }
      // The completion range starts AFTER the trigger char, so CM filters the
      // options by the typed name (not the `@`/`+`). `apply` still replaces from
      // the trigger so the sugar char is removed on insert.
      const triggerFrom = before.from;
      const from = triggerFrom + cat.trigger.length;
      const typed = before.text.slice(cat.trigger.length).trim();
      const typedLower = typed.toLowerCase();
      const names = notesInCategory(getCachedPages(), cat)
        .filter((n) => !typedLower || n.toLowerCase().includes(typedLower))
        .slice(0, 50);
      const options: Completion[] = names.map((n) => ({
        label: n,
        type: "text",
        apply: (view: EditorView, _c: Completion, _from: number, to: number) =>
          insertWikilink(view, triggerFrom, to, n),
      }));
      if (typed && !names.some((n) => n.toLowerCase() === typedLower)) {
        options.push({
          label: `➕ Create "${typed}" as ${cat.name}`,
          type: "text",
          apply: (view: EditorView, _c: Completion, _from: number, to: number) => {
            insertWikilink(view, triggerFrom, to, typed);
            cb.createCategoryNote(cat.id, typed);
          },
        });
      }
      return { from, options, validFor: /^[\w .'-]*$/ };
    }
    return null;
  };
}

/** All Onyx-specific editor extensions. */
export function onyxExtensions(cb: EditorCallbacks): Extension[] {
  return [
    syntaxHighlighting(markdownHighlight),
    renderEngine(cb, nodeRules, regexRules),
    clickHandler(cb),
    autocompletion({ override: [wikilinkSource(cb), categorySource(cb)] }),
    EditorView.lineWrapping,
  ];
}
