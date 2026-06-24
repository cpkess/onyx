import { useState } from "react";
import { useStore } from "../state/store";
import { getActiveEditor } from "../editor/activeEditor";
import { api } from "../lib/api";
import { analyze, applyWeave, type Weave } from "../streamweaver";
import { invalidatePages } from "../dataview/pages";

const KIND_LABEL: Record<Weave["kind"], string> = {
  link: "Link",
  task: "Task",
  tag: "Tag",
  distribute: "Distribute",
  create: "New note",
};

function describe(w: Weave): string {
  switch (w.kind) {
    case "link":
      return `${w.text} → [[${w.name}]]${w.exists ? "" : " (new)"}`;
    case "task":
      return `${w.text}${w.due ? ` 📅 ${w.due}` : ""}`;
    case "tag":
      return `#${w.tag}`;
    case "distribute":
      return `→ [[${w.target}]] · ${w.reason}`;
    case "create":
      return `Create [[${w.name}]] from template`;
  }
}

export function WeavePanel() {
  const activeTab = useStore((s) => s.activeTab);
  const refreshTree = useStore((s) => s.refreshTree);

  const [weaves, setWeaves] = useState<Weave[]>([]);
  const [busy, setBusy] = useState(false);
  const [ran, setRan] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const runAnalyze = async () => {
    if (!activeTab) return;
    setBusy(true);
    setError(null);
    setWeaves([]);
    try {
      const view = getActiveEditor();
      const content = view ? view.state.doc.toString() : await api.readNote(activeTab);
      setWeaves(await analyze(content));
      setRan(true);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  const accept = async (w: Weave) => {
    await applyWeave(w, activeTab);
    setWeaves((prev) => prev.filter((x) => x.id !== w.id));
    await refreshTree();
    invalidatePages();
  };
  const ignore = (w: Weave) => setWeaves((prev) => prev.filter((x) => x.id !== w.id));
  const weaveAll = async () => {
    for (const w of [...weaves]) await applyWeave(w, activeTab);
    setWeaves([]);
    await refreshTree();
    invalidatePages();
  };

  return (
    <div className="flex h-full flex-col">
      <div className="px-2 py-2">
        <button
          onClick={runAnalyze}
          disabled={busy || !activeTab}
          className="w-full rounded-md border border-[var(--onyx-accent)] px-3 py-1.5 text-sm font-medium text-[var(--onyx-accent)] hover:bg-[var(--onyx-accent)]/10 disabled:opacity-40"
        >
          {busy ? "Weaving…" : weaves.length > 0 ? "Re-weave note" : "Weave note"}
        </button>
      </div>

      {weaves.length > 0 && (
        <div className="px-2 pb-2">
          <button
            onClick={weaveAll}
            className="w-full rounded-md bg-[var(--onyx-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Weave All ({weaves.length})
          </button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-2 pb-4">
        {busy && <p className="px-1 py-2 text-xs text-neutral-400">Analyzing…</p>}
        {!busy && error && <p className="px-1 py-2 text-xs text-red-500">{error}</p>}
        {!busy && !error && !activeTab && (
          <p className="px-1 py-2 text-xs text-neutral-400">Open a note to weave.</p>
        )}
        {!busy && !error && activeTab && !ran && (
          <p className="px-1 py-2 text-xs text-neutral-400">
            Click “Weave note” to analyze the current note.
          </p>
        )}
        {!busy && !error && activeTab && ran && weaves.length === 0 && (
          <p className="px-1 py-2 text-xs text-neutral-400">
            No proposals. (Needs LM Studio running with a chat model.)
          </p>
        )}
        {weaves.map((w) => (
          <div
            key={w.id}
            className="mb-1.5 rounded-md border border-black/10 p-2 dark:border-white/10"
          >
            <div className="mb-1 text-[10px] uppercase tracking-wide text-[var(--onyx-accent)]">
              {KIND_LABEL[w.kind]}
            </div>
            <div className="mb-1.5 break-words text-sm text-neutral-700 dark:text-neutral-200">
              {describe(w)}
            </div>
            <div className="flex gap-2">
              <button
                onClick={() => accept(w)}
                className="rounded bg-black/5 px-2 py-0.5 text-xs text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200"
              >
                Accept
              </button>
              <button
                onClick={() => ignore(w)}
                className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:bg-black/5 dark:hover:bg-white/5"
              >
                Ignore
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
