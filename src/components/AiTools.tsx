import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "../lib/api";
import { useStore } from "../state/store";
import { generatedKind, regenerateActivePage, type GeneratedKind } from "../lib/regenerate";
import { hasHcm, composeActivePage } from "../lib/compose";

type ScopeKind = "tag" | "folder" | "all";

export function AiTools() {
  const openNote = useStore((s) => s.openNote);
  const refreshTree = useStore((s) => s.refreshTree);
  const activeTab = useStore((s) => s.activeTab);

  const [scopeKind, setScopeKind] = useState<ScopeKind>("tag");
  const [scopeValue, setScopeValue] = useState("");
  const [subject, setSubject] = useState("");
  const [busy, setBusy] = useState<"synth" | "subject" | "regen" | "compose" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [genKind, setGenKind] = useState<GeneratedKind | null>(null);
  const [hcm, setHcm] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);

  // Detect whether the active note is an AI-generated page and/or carries HCM
  // blocks (so we can offer to regenerate or compose it).
  useEffect(() => {
    setGenKind(null);
    setHcm(false);
    if (!activeTab) return;
    let cancelled = false;
    api
      .readNote(activeTab)
      .then((c) => {
        if (cancelled) return;
        setGenKind(generatedKind(c));
        setHcm(hasHcm(c));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  // Section-compose progress.
  useEffect(() => {
    const un = [
      listen<{ done: number; total: number }>("ai-compose:progress", (e) =>
        setProgress(e.payload)
      ),
      listen("ai-compose:done", () => setProgress(null)),
    ];
    return () => un.forEach((u) => u.then((f) => f()));
  }, []);

  const runRegenerate = async () => {
    setBusy("regen");
    setError(null);
    try {
      await regenerateActivePage();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const runCompose = async () => {
    setBusy("compose");
    setError(null);
    setProgress(null);
    try {
      await composeActivePage();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
      setProgress(null);
    }
  };

  const createAndOpen = async (title: string, content: string) => {
    // A generated title is a flat filename, not a folder path — keep "/" out.
    const rel = await api.createNoteWithContent(title.replace(/[\\/]/g, "-"), content);
    await refreshTree();
    openNote(rel);
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
    <div className="h-full overflow-y-auto px-2 py-2">
      {error && <p className="mb-3 text-sm text-red-500">{error}</p>}
      <div className="space-y-4">
          {/* Regenerate (only for AI-generated pages) */}
          {genKind && (
            <div className="rounded-lg border border-[var(--onyx-accent)]/40 bg-[var(--onyx-accent)]/5 p-4">
              <h3 className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                Regenerate page
              </h3>
              <p className="mb-3 text-xs text-neutral-400">
                This {genKind === "subject" ? "subject" : "synthesis"} page was generated
                by Onyx. Regenerate it to pull in the latest from your vault (the body is
                rewritten; the page settings are kept).
              </p>
              <button
                onClick={runRegenerate}
                disabled={busy !== null}
                className={primary}
              >
                {busy === "regen" ? "Regenerating…" : "Regenerate from vault"}
              </button>
            </div>
          )}

          {/* Compose sections from HCM (only for pages with <!--ai--> blocks) */}
          {hcm && (
            <div className="rounded-lg border border-[var(--onyx-accent)]/40 bg-[var(--onyx-accent)]/5 p-4">
              <h3 className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
                Compose with AI context
              </h3>
              <p className="mb-3 text-xs text-neutral-400">
                This page has ✨ AI-context blocks. Compose regenerates only those
                sections from their instructions (inheriting parent context, grounded
                in your vault); other sections stay untouched.
              </p>
              <button
                onClick={runCompose}
                disabled={busy !== null}
                className={primary}
              >
                {busy === "compose"
                  ? progress
                    ? `Composing ${progress.done}/${progress.total}…`
                    : "Composing…"
                  : "Compose sections"}
              </button>
            </div>
          )}

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
  );
}
