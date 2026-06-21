import { useEffect, useRef } from "react";
import { EditorView, keymap, drawSelection, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment } from "@codemirror/state";
import { history, defaultKeymap, historyKeymap, indentWithTab } from "@codemirror/commands";
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
import { setActiveEditor, clearActiveEditor } from "./activeEditor";
import { setHost, getPendingScroll, setPendingScroll } from "./render/host";

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
});

export function Editor({ path }: { path: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const namesCompartment = useRef(new Compartment());
  const namesRef = useRef<string[]>([]);
  const saveTimer = useRef<number | undefined>(undefined);

  const openNote = useStore((s) => s.openNote);
  const createAndOpen = useStore((s) => s.createAndOpen);
  const tree = useStore((s) => s.tree);

  // Keep the autocomplete/link name list fresh as the vault changes.
  useEffect(() => {
    api
      .getNoteNames()
      .then((names) => {
        // Skip the reconfigure (and the decoration rebuild it triggers) when the
        // set of note names hasn't actually changed.
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

  useEffect(() => {
    let disposed = false;

    // Configure async resolvers used by image/embed widgets for this note.
    setHost({
      resolveAsset: (target: string) => api.resolveAsset(path, target),
      readNote: (p: string) => api.readNote(p).catch(() => null),
      resolvePath: (name: string) => api.resolveLink(name),
    });

    const callbacks = {
      getNoteNames: () => namesRef.current,
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
        api.writeNote(path, content).catch((e) => console.error("save failed", e));
      }, 400);
    };

    api.readNote(path).then((content) => {
      if (disposed || !ref.current) return;
      const state = EditorState.create({
        doc: content,
        extensions: [
          history(),
          drawSelection(),
          highlightActiveLine(),
          closeBrackets(),
          keymap.of([
            ...closeBracketsKeymap,
            ...defaultKeymap,
            ...historyKeymap,
            ...completionKeymap,
            indentWithTab,
          ]),
          markdown({ base: markdownLanguage, codeLanguages: languages }),
          namesCompartment.current.of(
            noteNamesFacet.of(
              new Set(namesRef.current.map((n) => n.toLowerCase()))
            )
          ),
          ...onyxExtensions(callbacks),
          editorTheme,
          EditorView.updateListener.of((u) => {
            if (u.docChanged) scheduleSave(u.state.doc.toString());
          }),
        ],
      });
      const view = new EditorView({ state, parent: ref.current });
      viewRef.current = view;
      setActiveEditor(view);

      // One-shot rebuild once the markdown parser has settled, so block widgets
      // render on load without rebuilding on every parser-progress tick.
      window.setTimeout(() => {
        if (!disposed && viewRef.current === view) {
          view.dispatch({ selection: view.state.selection });
        }
      }, 60);

      // If we navigated here via a [[Note#Heading]] link, scroll to it.
      const ps = getPendingScroll();
      if (ps && ps.path === path) {
        setPendingScroll(null);
        scrollToAnchor(view, ps.anchor);
      }
    });

    return () => {
      disposed = true;
      window.clearTimeout(saveTimer.current);
      // Flush a pending save synchronously-ish before tearing down.
      const view = viewRef.current;
      if (view) {
        api.writeNote(path, view.state.doc.toString()).catch(() => {});
        clearActiveEditor(view);
        view.destroy();
        viewRef.current = null;
      }
    };
    // Remounted per path via React key, so path is effectively constant here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path]);

  return (
    <div className="h-full overflow-hidden">
      <div className="px-7 pt-4 text-xs uppercase tracking-wide text-neutral-400">
        {noteName(path)}
      </div>
      <div ref={ref} className="h-[calc(100%-2rem)]" />
    </div>
  );
}
