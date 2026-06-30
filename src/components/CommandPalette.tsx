import { useEffect, useMemo, useRef, useState } from "react";
import { api, noteName, type SearchResult, type TreeNode } from "../lib/api";
import { useStore, type PaletteMode } from "../state/store";
import { kindLabel } from "../features/atoms/kinds";
import { commands, type Command } from "../commands/registry";

function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.is_dir) flatten(n.children, out);
    else out.push(n.path);
  }
  return out;
}

function keyHint(keys?: string): string {
  if (!keys) return "";
  return keys
    .replace("mod", "⌘")
    .replace("shift", "⇧")
    .replace("alt", "⌥")
    .split("+")
    .map((p) => (p.length === 1 ? p.toUpperCase() : p))
    .join("");
}

const KIND_LABEL: Record<PaletteMode, string> = {
  commands: "Commands",
  files: "Files",
  semantic: "AI",
  atoms: "Atoms",
};

export function CommandPalette() {
  const open = useStore((s) => s.paletteOpen);
  const kind = useStore((s) => s.paletteMode);
  const setOpen = useStore((s) => s.setPaletteOpen);
  const switchKind = useStore((s) => s.openPalette);
  const openNote = useStore((s) => s.openNote);
  const createAndOpen = useStore((s) => s.createAndOpen);
  const tree = useStore((s) => s.tree);
  const recent = useStore((s) => s.recent);

  const [query, setQuery] = useState("");
  const [fileResults, setFileResults] = useState<SearchResult[]>([]);
  const [sel, setSel] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const allNotes = useMemo(() => flatten(tree), [tree]);

  const commandResults = useMemo<Command[]>(() => {
    const q = query.trim().toLowerCase();
    return commands.filter((c) => !q || c.name.toLowerCase().includes(q));
  }, [query]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setSel(0);
      setFileResults([]);
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [open, kind]);

  // File / semantic search (commands are filtered synchronously above).
  useEffect(() => {
    if (kind === "commands") return;
    setSel(0);
    setError(null);
    const raw = query.trim();

    if (kind === "atoms") {
      if (!raw) return setFileResults([]);
      setBusy(true);
      const id = window.setTimeout(() => {
        api
          .getAtoms({ query: raw })
          .then((atoms) => {
            setFileResults(
              atoms.map((a) => ({
                path: a.source_path,
                title: a.text,
                snippet: `${kindLabel(a.kind)} · ${noteName(a.source_path)}`,
              }))
            );
            if (atoms.length === 0) setError("No matching atoms.");
          })
          .catch((e) => {
            setFileResults([]);
            setError(String(e));
          })
          .finally(() => setBusy(false));
      }, 200);
      return () => window.clearTimeout(id);
    }

    if (kind === "semantic") {
      if (!raw) return setFileResults([]);
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
              res.push({ path: h.path, title: noteName(h.path), snippet: h.text.slice(0, 160) });
            }
            setFileResults(res);
            if (res.length === 0) setError("No matches. Index the vault in Settings?");
          })
          .catch((e) => {
            setFileResults([]);
            setError(String(e));
          })
          .finally(() => setBusy(false));
      }, 250);
      return () => window.clearTimeout(id);
    }

    // files — recent first when there's no query (quick switcher)
    const q = raw.toLowerCase();
    const ordered = q
      ? allNotes.filter((p) => noteName(p).toLowerCase().includes(q))
      : [
          ...recent.filter((p) => allNotes.includes(p)),
          ...allNotes.filter((p) => !recent.includes(p)),
        ];
    const nameMatches: SearchResult[] = ordered
      .slice(0, 50)
      .map((p) => ({ path: p, title: noteName(p), snippet: "" }));
    if (!q) return setFileResults(nameMatches);
    const id = window.setTimeout(() => {
      api
        .searchNotes(query)
        .then((fts) => {
          const seen = new Set(nameMatches.map((r) => r.path));
          const merged = [...nameMatches];
          for (const r of fts) if (!seen.has(r.path)) merged.push(r);
          setFileResults(merged.slice(0, 50));
        })
        .catch(() => setFileResults(nameMatches));
    }, 120);
    return () => window.clearTimeout(id);
  }, [query, allNotes, kind, recent]);

  if (!open) return null;

  const count = kind === "commands" ? commandResults.length : fileResults.length;

  const choose = (i: number) => {
    if (kind === "commands") {
      const cmd = commandResults[i];
      if (cmd) {
        setOpen(false);
        cmd.run();
      }
      return;
    }
    const r = fileResults[i];
    if (r) {
      openNote(r.path);
      setOpen(false);
    } else if (kind === "files" && query.trim()) {
      createAndOpen(query.trim());
      setOpen(false);
    }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") setOpen(false);
    else if (e.key === "ArrowDown") {
      e.preventDefault();
      setSel((s) => Math.min(s + 1, count - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setSel((s) => Math.max(s - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      choose(sel);
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
              kind === "commands"
                ? "Run a command…"
                : kind === "semantic"
                  ? "Semantic search across your notes…"
                  : kind === "atoms"
                    ? "Search your knowledge atoms…"
                    : "Search or jump to a note… (Enter creates on no match)"
            }
            className="flex-1 bg-transparent px-1 py-3 text-base text-neutral-900 outline-none placeholder:text-neutral-400 dark:text-white"
          />
          <div className="flex shrink-0 rounded-md bg-black/5 p-0.5 text-xs dark:bg-white/10">
            {(["commands", "files", "semantic", "atoms"] as PaletteMode[]).map((k) => (
              <button
                key={k}
                onClick={() => switchKind(k)}
                className={`rounded px-2 py-1 ${
                  kind === k
                    ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
                    : "text-neutral-500"
                }`}
              >
                {KIND_LABEL[k]}
              </button>
            ))}
          </div>
        </div>

        <div className="max-h-[50vh] overflow-y-auto border-t border-black/10 dark:border-white/10">
          {busy && (
            <div className="px-4 py-3 text-center text-sm text-neutral-400">Searching…</div>
          )}
          {!busy && error && (
            <div className="px-4 py-6 text-center text-sm text-neutral-400">{error}</div>
          )}
          {!busy && !error && count === 0 && (
            <div className="px-4 py-6 text-center text-sm text-neutral-400">
              {kind === "commands"
                ? "No matching commands."
                : kind === "files" && query.trim()
                  ? "No matches — press Enter to create this note."
                  : "Type to search."}
            </div>
          )}

          {kind === "commands"
            ? commandResults.map((c, i) => (
                <button
                  key={c.id}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(i)}
                  className={`flex w-full items-center justify-between px-4 py-2 text-left ${
                    i === sel ? "bg-black/5 dark:bg-white/10" : ""
                  }`}
                >
                  <span className="text-sm text-neutral-800 dark:text-neutral-100">{c.name}</span>
                  {c.keys && (
                    <span className="text-xs text-neutral-400">{keyHint(c.keys)}</span>
                  )}
                </button>
              ))
            : fileResults.map((r, i) => (
                <button
                  key={`${r.path}-${i}`}
                  onMouseEnter={() => setSel(i)}
                  onClick={() => choose(i)}
                  className={`block w-full px-4 py-2 text-left ${
                    i === sel ? "bg-black/5 dark:bg-white/10" : ""
                  }`}
                >
                  <div className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
                    {r.title}
                  </div>
                  <div className="truncate text-xs text-neutral-400">{r.snippet || r.path}</div>
                </button>
              ))}
        </div>
      </div>
    </div>
  );
}
