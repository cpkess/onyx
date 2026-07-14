import { useEffect, useRef } from "react";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  foldGutter,
  codeFolding,
  foldKeymap,
  foldService,
} from "@codemirror/language";
import { search, searchKeymap } from "@codemirror/search";
import { markdown, markdownLanguage } from "@codemirror/lang-markdown";
import { languages } from "@codemirror/language-data";
import {
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { api, noteName } from "../lib/api";
import { useStore } from "../state/store";
import { onyxExtensions, noteNamesFacet } from "./extensions";
import { setActiveEditor, clearActiveEditor, isDeleted } from "./activeEditor";
import { EditorToolbar } from "./EditorToolbar";
import { queueIndex } from "../lib/autoindex";
import { trackEvent } from "../features/night/track";
import { setHost, getPendingScroll, setPendingScroll } from "./render/host";
import { editorModeFacet, rerenderEffect, type EditorMode } from "./render/core";
import { ensurePages, onPagesChanged } from "../dataview/pages";
import { ensureBlockRefs, ensureAtoms, onBlockRefsChanged } from "../dataview/blockrefs";
import { outlinerExtensions, outlinerKeymap } from "./outliner";
import { parseDailyDate, shiftDays } from "../lib/daily";

/** Fold a markdown heading down to (but not including) the next same/higher heading. */
const headingFold = foldService.of((state, from) => {
  const line = state.doc.lineAt(from);
  const m = line.text.match(/^(#{1,6})\s/);
  if (!m) return null;
  const level = m[1].length;
  let end = state.doc.length;
  for (let i = line.number + 1; i <= state.doc.lines; i++) {
    const hm = state.doc.line(i).text.match(/^(#{1,6})\s/);
    if (hm && hm[1].length <= level) {
      end = state.doc.line(i - 1).to;
      break;
    }
  }
  return end > line.to ? { from: line.to, to: end } : null;
});

function modeExtensions(mode: EditorMode) {
  return [editorModeFacet.of(mode), EditorView.editable.of(mode !== "reading")];
}

// Native (macOS WKWebView) spell check. Squiggles + right-click suggestions only —
// autocorrect/autocapitalize stay off so Markdown, code, and [[wikilinks]] aren't rewritten.
function spellcheckExtensions(on: boolean) {
  return EditorView.contentAttributes.of({
    spellcheck: on ? "true" : "false",
    autocorrect: "off",
    autocapitalize: "off",
  });
}

function countStats(text: string) {
  const words = (text.match(/\S+/g) ?? []).length;
  return { words, chars: text.length };
}

/** Scroll the view to a heading or `^block` anchor. */
function scrollToAnchor(view: EditorView, anchor: string) {
  const doc = view.state.doc;
  let pos = -1;
  if (anchor.startsWith("^")) {
    const id = anchor.slice(1);
    for (let i = 1; i <= doc.lines; i++) {
      const l = doc.line(i);
      if (l.text.trimEnd().endsWith("^" + id)) {
        pos = l.from;
        break;
      }
    }
  } else {
    const a = anchor.toLowerCase();
    for (let i = 1; i <= doc.lines; i++) {
      const m = doc.line(i).text.match(/^#{1,6}\s+(.*)$/);
      if (m && m[1].trim().toLowerCase() === a) {
        pos = doc.line(i).from;
        break;
      }
    }
  }
  if (pos >= 0) {
    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: "start" }),
    });
  }
}

const editorTheme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "inherit" },
  ".cm-content": { caretColor: "var(--onyx-accent)" },
  ".cm-cursor": { borderLeftColor: "var(--onyx-accent)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in srgb, var(--onyx-accent) 25%, transparent)",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in srgb, gray 8%, transparent)" },
  ".cm-gutters": { backgroundColor: "transparent", border: "none", color: "#9994" },
});

const MODES: EditorMode[] = ["source", "live", "reading"];
const MODE_LABELS: Record<EditorMode, string> = {
  source: "Source",
  live: "Live",
  reading: "Read",
};

export function Editor({ path, paneId }: { path: string; paneId?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const namesCompartment = useRef(new Compartment());
  const modeCompartment = useRef(new Compartment());
  const outlinerCompartment = useRef(new Compartment());
  const spellcheckCompartment = useRef(new Compartment());
  const namesRef = useRef<string[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);

  const openNote = useStore((s) => s.openNote);
  const createAndOpen = useStore((s) => s.createAndOpen);
  const setNoteMode = useStore((s) => s.setNoteMode);
  const tree = useStore((s) => s.tree);
  const mode = useStore((s) => s.noteModes[path] ?? s.settings.defaultMode);
  const outliner = useStore((s) => s.settings.outliner);
  const spellcheck = useStore((s) => s.settings.spellcheck ?? true);
  const settings = useStore((s) => s.settings);
  const openDailyNote = useStore((s) => s.openDailyNote);
  const journalDate = parseDailyDate(path, settings);

  // Keep the autocomplete/link name list fresh as the vault changes.
  useEffect(() => {
    api
      .getNoteNames()
      .then((names) => {
        const prev = namesRef.current;
        const unchanged =
          prev.length === names.length && prev.every((n, i) => n === names[i]);
        if (unchanged) return;
        namesRef.current = names;
        const view = viewRef.current;
        if (view) {
          view.dispatch({
            effects: namesCompartment.current.reconfigure(
              noteNamesFacet.of(new Set(names.map((n) => n.toLowerCase())))
            ),
          });
        }
      })
      .catch(() => {});
  }, [tree]);

  // Reconfigure when the view mode changes.
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: modeCompartment.current.reconfigure(modeExtensions(mode)),
      });
    }
  }, [mode]);

  // Toggle the block outliner without reopening the note.
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: outlinerCompartment.current.reconfigure(outlinerExtensions(outliner)),
      });
    }
  }, [outliner]);

  // Toggle native spell check on open notes without reopening them.
  useEffect(() => {
    const view = viewRef.current;
    if (view) {
      view.dispatch({
        effects: spellcheckCompartment.current.reconfigure(spellcheckExtensions(spellcheck)),
      });
    }
  }, [spellcheck]);

  useEffect(() => {
    let disposed = false;

    setHost({
      resolveAsset: (target: string) => api.resolveAsset(path, target),
      readNote: (p: string) => api.readNote(p).catch(() => null),
      resolvePath: (name: string) => api.resolveLink(name),
    });

    // Re-render dataview widgets when the page cache changes. Use a rebuild
    // effect (not a selection dispatch) so an open autocomplete popup survives.
    const unsubPages = onPagesChanged(() => {
      const v = viewRef.current;
      if (v) v.dispatch({ effects: rerenderEffect.of(null) });
    });

    // Re-render the Linked References section when its cache changes.
    const unsubRefs = onBlockRefsChanged(() => {
      const v = viewRef.current;
      if (v) v.dispatch({ effects: rerenderEffect.of(null) });
    });

    const callbacks = {
      currentPath: path,
      getNoteNames: () => namesRef.current,
      getCategories: () => useStore.getState().settings.categories,
      createCategoryNote: (id: string, name: string) => {
        void useStore.getState().createCategoryNote(id, name);
      },
      onFollowLink: async (name: string, anchor?: string) => {
        const resolved = await api.resolveLink(name);
        if (resolved) {
          if (anchor) setPendingScroll({ path: resolved, anchor });
          openNote(resolved);
        } else await createAndOpen(name);
      },
    };

    const scheduleSave = (content: string) => {
      window.clearTimeout(saveTimer.current);
      saveTimer.current = window.setTimeout(() => {
        if (isDeleted(path)) return; // don't resurrect a deleted note
        api
          .writeNote(path, content)
          .then(() => {
            queueIndex(path);
            trackEvent("EDIT_NOTE", path);
          })
          .catch((e) => console.error("save failed", e));
      }, 400);
    };

    api.readNote(path).then((content) => {
      if (disposed || !ref.current) return;
      const initialMode =
        useStore.getState().noteModes[path] ?? useStore.getState().settings.defaultMode;
      const state = EditorState.create({
        doc: content,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          closeBrackets(),
          codeFolding(),
          foldGutter(),
          headingFold,
          outlinerCompartment.current.of(
            outlinerExtensions(useStore.getState().settings.outliner)
          ),
          search({ top: true }),
          keymap.of([
            ...closeBracketsKeymap,
            // Completion accept (Enter/arrows) must win over the outliner keys
            // while the wikilink popup is open — otherwise Enter splits the block
            // instead of selecting. These bindings no-op when no popup is active.
            ...completionKeymap,
            ...outlinerKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...foldKeymap,
            ...searchKeymap,
            indentWithTab,
          ]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          EditorView.domEventHandlers({
            paste(event, view) {
              const items = event.clipboardData?.items;
              if (!items) return false;
              for (const it of items) {
                if (it.type.startsWith("image/")) {
                  const file = it.getAsFile();
                  if (!file) continue;
                  event.preventDefault();
                  file.arrayBuffer().then(async (buf) => {
                    const bytes = Array.from(new Uint8Array(buf));
                    try {
                      const fname = await api.saveAttachment(
                        file.name || `image.${it.type.split("/")[1] || "png"}`,
                        bytes,
                        useStore.getState().settings.attachmentsFolder
                      );
                      const pos = view.state.selection.main.head;
                      const text = `![[${fname}]]`;
                      view.dispatch({
                        changes: { from: pos, insert: text },
                        selection: { anchor: pos + text.length },
                      });
                    } catch (e) {
                      console.error("attachment save failed", e);
                    }
                  });
                  return true;
                }
              }
              return false;
            },
          }),
          modeCompartment.current.of(modeExtensions(initialMode)),
          spellcheckCompartment.current.of(
            spellcheckExtensions(useStore.getState().settings.spellcheck ?? true)
          ),
          namesCompartment.current.of(
            noteNamesFacet.of(new Set(namesRef.current.map((n) => n.toLowerCase())))
          ),
          ...onyxExtensions(callbacks),
          editorTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) {
              const text = u.state.doc.toString();
              scheduleSave(text);
              useStore.getState().setEditorStats(countStats(text));
            }
            if (u.focusChanged && u.view.hasFocus) {
              setActiveEditor(u.view, path);
              if (paneId) useStore.getState().setActivePane(paneId);
            }
          }),
        ],
      });
      const view = new EditorView({ state, parent: ref.current });
      viewRef.current = view;
      setActiveEditor(view, path);
      useStore.getState().setEditorStats(countStats(content));

      window.setTimeout(() => {
        if (!disposed && viewRef.current === view) {
          view.dispatch({ effects: rerenderEffect.of(null) });
        }
      }, 60);

      // Load Dataview pages and re-render dataview/inline-DQL widgets when ready.
      ensurePages().then(() => {
        if (!disposed && viewRef.current === view) {
          view.dispatch({ effects: rerenderEffect.of(null) });
        }
      });

      // Load this page's linked references + atoms (self-building pages).
      ensureBlockRefs(noteName(path));
      ensureAtoms(noteName(path));

      const ps = getPendingScroll();
      if (ps && ps.path === path) {
        setPendingScroll(null);
        scrollToAnchor(view, ps.anchor);
      }
    });

    return () => {
      disposed = true;
      unsubPages();
      unsubRefs();
      window.clearTimeout(saveTimer.current);
      const view = viewRef.current;
      if (view) {
        if (!isDeleted(path)) {
          api.writeNote(path, view.state.doc.toString()).catch(() => {});
        }
        clearActiveEditor(view);
        view.destroy();
        viewRef.current = null;
      }
      useStore.getState().setEditorStats(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 items-center justify-between px-7 pt-3 pb-1">
        <span className="truncate text-xs uppercase tracking-wide text-neutral-400">
          {noteName(path)}
        </span>
        <div className="flex rounded-md bg-black/5 p-0.5 text-xs dark:bg-white/10">
          {MODES.map((m) => (
            <button
              key={m}
              onClick={() => setNoteMode(path, m)}
              className={`rounded px-2 py-0.5 ${
                mode === m
                  ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
                  : "text-neutral-500"
              }`}
              title={`${MODE_LABELS[m]} mode`}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>
      </div>
      {journalDate && (
        <div className="flex shrink-0 items-center justify-center gap-4 px-7 pb-1 text-xs text-neutral-500">
          <button
            className="rounded px-1.5 py-0.5 hover:bg-black/5 hover:text-[var(--onyx-accent)] dark:hover:bg-white/10"
            title="Previous day"
            onClick={() => openDailyNote(shiftDays(journalDate, -1))}
          >
            ‹ {shiftDays(journalDate, -1).toLocaleDateString(undefined, { month: "short", day: "numeric" })}
          </button>
          <button
            className="rounded px-1.5 py-0.5 font-medium hover:bg-black/5 hover:text-[var(--onyx-accent)] dark:hover:bg-white/10"
            title="Today's journal"
            onClick={() => openDailyNote(new Date())}
          >
            Today
          </button>
          <button
            className="rounded px-1.5 py-0.5 hover:bg-black/5 hover:text-[var(--onyx-accent)] dark:hover:bg-white/10"
            title="Next day"
            onClick={() => openDailyNote(shiftDays(journalDate, 1))}
          >
            {shiftDays(journalDate, 1).toLocaleDateString(undefined, { month: "short", day: "numeric" })} ›
          </button>
        </div>
      )}
      <EditorToolbar path={path} />
      <div ref={ref} className="min-h-0 flex-1" />
    </div>
  );
}
