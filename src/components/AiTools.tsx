import { useState } from "react";
import { api } from "../lib/api";
import { useStore } from "../state/store";

type ScopeKind = "tag" | "folder" | "all";

export function AiTools() {
  const open = useStore((s) => s.aiToolsOpen);
  const setOpen = useStore((s) => s.setAiToolsOpen);
  const openNote = useStore((s) => s.openNote);
  const refreshTree = useStore((s) => s.refreshTree);

  const [scopeKind, setScopeKind] = useState<ScopeKind>("tag");
  const [scopeValue, setScopeValue] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState<"synth" | "subject" | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (!open) return null;

  const createAndOpen = async (title: string, content: string) => {
    const rel = await api.createNoteWithContent(title, content);
    await refreshTree();
    openNote(rel);
    setOpen(false);
  };

  const runSynthesis = async () => {
    setBusy("synth");
    setError(null);
    try {
      const doc = await api.aiSynthesize(
        scopeKind,
        scopeKind === "all" ? "" : scopeValue.trim()
      );
      await createAndOpen(doc.title, doc.content);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runSubjectPage = async () => {
    if (!subject.trim()) return;
    setBusy("subject");
    setError(null);
    try {
      const doc = await api.aiSubjectPage(subject.trim());
      await createAndOpen(doc.title, doc.content);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const field =
    "w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-[var(--onyx-accent)] dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100";
  const primary =
    "rounded-md bg-[var(--onyx-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[10vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[34rem] max-w-[92vw] rounded-xl bg-white p-6 shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">
            AI Tools
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-2 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        {error && <p className="mb-3 text-sm text-red-500">{error}</p>}

        <div className="space-y-5">
          {/* Synthesize */}
          <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
            <h3 className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              Synthesize insights
            </h3>
            <p className="mb-3 text-xs text-neutral-400">
              Combine a set of notes into a brief: themes, connections,
              contradictions, open questions. Saved as a new note.
            </p>
            <div className="flex gap-2">
              <select
                className={field + " max-w-[10rem]"}
                value={scopeKind}
                onChange={(e) => setScopeKind(e.target.value as ScopeKind)}
              >
                <option value="tag">By tag</option>
                <option value="folder">By folder</option>
                <option value="all">Whole vault</option>
              </select>
              {scopeKind !== "all" && (
                <input
                  className={field}
                  value={scopeValue}
                  onChange={(e) => setScopeValue(e.target.value)}
                  placeholder={
                    scopeKind === "tag" ? "tag (e.g. onyx)" : "folder (e.g. Projects)"
                  }
                />
              )}
            </div>
            <button
              onClick={runSynthesis}
              disabled={busy !== null || (scopeKind !== "all" && !scopeValue.trim())}
              className={primary + " mt-3"}
            >
              {busy === "synth" ? "Synthesizing…" : "Generate synthesis"}
            </button>
          </div>

          {/* Subject page */}
          <div className="rounded-lg border border-black/10 p-4 dark:border-white/10">
            <h3 className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
              Subject page
            </h3>
            <p className="mb-3 text-xs text-neutral-400">
              Generate a Wikipedia-style page about a subject, grounded in your
              notes with [[citations]]. Requires an indexed vault.
            </p>
            <input
              className={field}
              value={subject}
              onChange={(e) => setSubject(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && runSubjectPage()}
              placeholder="Subject (e.g. Knowledge management)"
            />
            <button
              onClick={runSubjectPage}
              disabled={busy !== null || !subject.trim()}
              className={primary + " mt-3"}
            >
              {busy === "subject" ? "Writing…" : "Generate page"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
