import { useEffect, useMemo, useRef, useState } from "react";
import { api, noteName, type SearchResult, type TreeNode } from "../lib/api";
import { useStore } from "../state/store";

function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.is_dir) flatten(n.children, out);
    else out.push(n.path);
  }
  return out;
}

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const openNote = useStore((s) => s.openNote);
  const createAndOpen = useStore((s) => s.createAndOpen);
  const tree = useStore((s) => s.tree);

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [sel, setSel] = useState(0);
  const [mode, setMode] = useState<"text" | "semantic">("text");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const allNotes = useMemo(() => flatten(tree), [tree]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      setResults([]);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open]);

  // Search effect: text (filename + FTS) or semantic (embeddings).
  useEffect(() => {
    setSel(0);
    setError(null);
    const raw = query.trim();

    if (mode === "semantic") {
      if (!raw) {
        setResults([]);
        return;
      }
      setBusy(true);
      const id = window.setTimeout(() => {
        api
          .aiSemanticSearch(raw, 20)
          .then((hits) => {
            const seen = new Set<string>();
            const res: SearchResult[] = [];
            for (const h of hits) {
              if (seen.has(h.path)) continue;
              seen.add(h.path);
              res.push({
                path: h.path,
                title: noteName(h.path),
                snippet: h.text.slice(0, 160),
              });
            }
            setResults(res);
            if (res.length === 0)
              setError("No matches. Have you indexed the vault in Settings?");
          })
          .catch((e) => {
            setResults([]);
            setError(String(e));
          })
          .finally(() => setBusy(false));
      }, 250);
      return () => window.clearTimeout(id);
    }

    // Text mode: filename matches (instant) + FTS (debounced).
    const q = raw.toLowerCase();
    const nameMatches: SearchResult[] = (
      q ? allNotes.filter((p) => noteName(p).toLowerCase().includes(q)) : allNotes
    )
      .slice(0, 50)
      .map((p) => ({ path: p, title: noteName(p), snippet: "" }));

    if (!q) {
      setResults(nameMatches);
      return;
    }
    const id = window.setTimeout(() => {
      api
        .searchNotes(query)
        .then((fts) => {
          const seen = new Set(nameMatches.map((r) => r.path));
          const merged = [...nameMatches];
          for (const r of fts) if (!seen.has(r.path)) merged.push(r);
          setResults(merged.slice(0, 50));
        })
        .catch(() => setResults(nameMatches));
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, allNotes, mode]);

  if (!open) return null;

  const choose = (path: string) => {
    openNote(path);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, results.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (results[sel]) choose(results[sel].path);
      else if (mode === "text" && query.trim()) {
        createAndOpen(query.trim());
        setOpen(false);
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[12vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[36rem] max-w-[90vw] overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3">
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={onKeyDown}
            placeholder={
              mode === "semantic"
                ? "Semantic search across your notes…"
                : "Search or jump to a note…  (Enter on no match creates it)"
            }
            className="flex-1 bg-transparent px-1 py-3 text-base text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-white"
          />
          <div className="flex shrink-0 rounded-md bg-black/5 p-0.5 text-xs dark:bg-white/10">
            {(["text", "semantic"] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`rounded px-2 py-1 capitalize ${
                  mode === m
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
                    : "text-neutral-500"
                }`}
              >
                {m === "semantic" ? "AI" : "Text"}
              </button>
            ))}
          </div>
        </div>
        <div className="max-h-[50vh] overflow-y-auto border-t border-black/10 dark:border-white/10">
          {busy && (
            <div className="px-4 py-3 text-center text-sm text-neutral-400">
              Searching…
            </div>
          )}
          {!busy && error && (
            <div className="px-4 py-6 text-center text-sm text-neutral-400">
              {error}
            </div>
          )}
          {!busy && !error && results.length === 0 && (
            <div className="px-4 py-6 text-center text-sm text-neutral-400">
              {mode === "semantic"
                ? "Type to search semantically."
                : query.trim()
                  ? "No matches — press Enter to create this note."
                  : "No notes."}
            </div>
          )}
          {results.map((r, i) => (
            <button
              key={r.path}
              onMouseEnter={() => setSel(i)}
              onClick={() => choose(r.path)}
              className={`block w-full px-4 py-2 text-left ${
                i === sel ? "bg-black/5 dark:bg-white/10" : ""
              }`}
            >
              <div className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                {r.title}
              </div>
              <div className="truncate text-xs text-neutral-400">
                {r.snippet || r.path}
              </div>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
