import { useEffect, useState } from "react";
import { api, noteName, type Backlink, type LinkSuggestion } from "../lib/api";
import { useStore } from "../state/store";
import { appendTags, insertText } from "../editor/activeEditor";

export function Sidebar() {
  const activeTab = useStore((s) => s.activeTab);
  const openNote = useStore((s) => s.openNote);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);

  useEffect(() => {
    if (!activeTab) {
      setBacklinks([]);
      return;
    }
    let cancelled = false;
    const id = window.setTimeout(() => {
      api
        .getBacklinks(noteName(activeTab))
        .then((bl) => !cancelled && setBacklinks(bl))
        .catch(() => !cancelled && setBacklinks([]));
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [activeTab]);

  return (
    <div className="flex h-full flex-col overflow-y-auto">
      <Section title="Backlinks">
        {!activeTab && <Empty>No note open.</Empty>}
        {activeTab && backlinks.length === 0 && <Empty>No backlinks yet.</Empty>}
        {backlinks.map((bl) => (
          <button
            key={bl.path}
            onClick={() => openNote(bl.path)}
            className="mb-1 block w-full rounded p-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
          >
            <div className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {bl.title}
            </div>
            {bl.snippet && (
              <div className="truncate text-xs text-neutral-400">{bl.snippet}</div>
            )}
          </button>
        ))}
      </Section>

      <AiAssist activeTab={activeTab} />
    </div>
  );
}

function AiAssist({ activeTab }: { activeTab: string | null }) {
  const openNote = useStore((s) => s.openNote);
  const [tags, setTags] = useState<string[] | null>(null);
  const [links, setLinks] = useState<LinkSuggestion[] | null>(null);
  const [busy, setBusy] = useState<"tags" | "links" | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Reset suggestions when the active note changes.
  useEffect(() => {
    setTags(null);
    setLinks(null);
    setError(null);
  }, [activeTab]);

  if (!activeTab) return null;

  const suggestTags = async () => {
    setBusy("tags");
    setError(null);
    try {
      setTags(await api.aiSuggestTags(activeTab));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const suggestLinks = async () => {
    setBusy("links");
    setError(null);
    try {
      setLinks(await api.aiSuggestLinks(activeTab));
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(null);
    }
  };

  const acceptTag = (tag: string) => {
    appendTags([tag]);
    setTags((prev) => prev?.filter((t) => t !== tag) ?? null);
  };
  const acceptAllTags = () => {
    if (tags && tags.length) appendTags(tags);
    setTags([]);
  };
  const acceptLink = (s: LinkSuggestion) => {
    insertText(`[[${s.name}]]`);
    setLinks((prev) => prev?.filter((l) => l.path !== s.path) ?? null);
  };

  const btn =
    "rounded-md bg-black/5 px-2 py-1 text-xs text-neutral-700 hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/20";

  return (
    <Section title="AI Assist" border>
      <div className="mb-2 flex gap-2">
        <button className={btn} onClick={suggestTags} disabled={busy !== null}>
          {busy === "tags" ? "Thinking…" : "Suggest tags"}
        </button>
        <button className={btn} onClick={suggestLinks} disabled={busy !== null}>
          {busy === "links" ? "Thinking…" : "Suggest links"}
        </button>
      </div>

      {error && <p className="px-1 text-xs text-red-500">{error}</p>}

      {tags && (
        <div className="mb-3">
          {tags.length === 0 ? (
            <Empty>No new tags suggested.</Empty>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5">
                {tags.map((t) => (
                  <button
                    key={t}
                    onClick={() => acceptTag(t)}
                    title="Click to add to note"
                    className="rounded-full bg-[var(--onyx-accent)]/15 px-2 py-0.5 text-xs text-[var(--onyx-accent)] hover:bg-[var(--onyx-accent)]/25"
                  >
                    #{t} +
                  </button>
                ))}
              </div>
              <button
                onClick={acceptAllTags}
                className="mt-1.5 text-xs text-neutral-400 underline hover:text-neutral-600"
              >
                Add all
              </button>
            </>
          )}
        </div>
      )}

      {links && (
        <div>
          {links.length === 0 ? (
            <Empty>No links suggested.</Empty>
          ) : (
            links.map((s) => (
              <div
                key={s.path}
                className="mb-1.5 rounded-md border border-black/10 p-2 dark:border-white/10"
              >
                <div className="flex items-center justify-between gap-2">
                  <button
                    onClick={() => openNote(s.path)}
                    className="truncate text-sm font-medium text-[var(--onyx-accent)] hover:underline"
                  >
                    {s.name}
                  </button>
                  <button
                    onClick={() => acceptLink(s)}
                    title="Insert [[link]] at cursor"
                    className="shrink-0 rounded bg-black/5 px-1.5 text-xs text-neutral-600 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-300"
                  >
                    Insert
                  </button>
                </div>
                {s.reason && (
                  <p className="mt-0.5 text-xs text-neutral-400">{s.reason}</p>
                )}
              </div>
            ))
          )}
        </div>
      )}
    </Section>
  );
}

function Section({
  title,
  children,
  border,
}: {
  title: string;
  children: React.ReactNode;
  border?: boolean;
}) {
  return (
    <div className={border ? "border-t border-black/10 dark:border-white/10" : ""}>
      <div className="px-3 py-2 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </div>
      <div className="px-2 pb-3">{children}</div>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 text-xs text-neutral-400">{children}</p>;
}
