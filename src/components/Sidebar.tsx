import { useEffect, useState } from "react";
import {
  api,
  noteName,
  type Backlink,
  type LinkSuggestion,
  type SearchResult,
} from "../lib/api";
import { useStore, type SidebarTab, type AiTool } from "../state/store";
import { appendTags, insertText, scrollToHeading } from "../editor/activeEditor";
import { ChatPanel } from "./ChatPanel";
import { AiTools } from "./AiTools";
import { WeavePanel } from "./WeavePanel";
import { CalendarTab } from "./CalendarTab";
import { NightTab } from "../features/night/NightTab";

export function Sidebar() {
  const activeTab = useStore((s) => s.activeTab);
  const tab = useStore((s) => s.sidebarTab);
  const setTab = useStore((s) => s.setSidebarTab);
  const [content, setContent] = useState("");

  // Load the active note's content once per change (for outline + outgoing).
  useEffect(() => {
    if (!activeTab) return setContent("");
    let cancelled = false;
    api
      .readNote(activeTab)
      .then((c) => !cancelled && setContent(c))
      .catch(() => !cancelled && setContent(""));
    return () => {
      cancelled = true;
    };
  }, [activeTab]);

  const tabs: [SidebarTab, string][] = [
    ["links", "Links"],
    ["outline", "Outline"],
    ["tags", "Tags"],
    ["marks", "★"],
    ["ai", "AI"],
    ["calendar", "📅"],
    ["night", "🌙"],
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 border-b border-black/10 text-xs dark:border-white/10">
        {tabs.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`flex-1 py-2 ${
              tab === t
                ? "border-b-2 border-[var(--onyx-accent)] font-medium text-neutral-800 dark:text-neutral-100"
                : "text-neutral-500"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="flex-1 overflow-y-auto">
        {tab === "links" && <LinksTab activeTab={activeTab} content={content} />}
        {tab === "outline" && <OutlineTab content={content} />}
        {tab === "tags" && <TagsTab />}
        {tab === "marks" && <BookmarksTab />}
        {tab === "ai" && <AiTab activeTab={activeTab} />}
        {tab === "calendar" && <CalendarTab />}
        {tab === "night" && <NightTab />}
      </div>
    </div>
  );
}

// ---- AI tab: sub-tools (Assist / Chat / Tools / Weave) ----

function AiTab({ activeTab }: { activeTab: string | null }) {
  const tool = useStore((s) => s.aiTool);
  const setTool = useStore((s) => s.setAiTool);

  const tools: [AiTool, string][] = [
    ["assist", "Assist"],
    ["chat", "Chat"],
    ["tools", "Tools"],
    ["weave", "Weave"],
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 px-2 py-1.5">
        {tools.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setTool(t)}
            className={`flex-1 rounded-md py-1 text-xs ${
              tool === t
                ? "bg-[var(--onyx-accent)] font-medium text-white"
                : "text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div
        className={`min-h-0 flex-1 ${
          tool === "assist" ? "overflow-y-auto" : "overflow-hidden"
        }`}
      >
        {tool === "assist" && <AiAssist activeTab={activeTab} />}
        {tool === "chat" && <ChatPanel />}
        {tool === "tools" && <AiTools />}
        {tool === "weave" && <WeavePanel key={activeTab ?? ""} />}
      </div>
    </div>
  );
}

// ---- Links: backlinks + outgoing + unlinked mentions ----

const WIKILINK_RE = /\[\[([^\]\n|#]+)(?:[#|][^\]\n]*)?\]\]/g;

function LinksTab({ activeTab, content }: { activeTab: string | null; content: string }) {
  const openNote = useStore((s) => s.openNote);
  const [backlinks, setBacklinks] = useState<Backlink[]>([]);
  const [unlinked, setUnlinked] = useState<SearchResult[]>([]);
  const [outgoing, setOutgoing] = useState<{ name: string; path: string | null }[]>([]);

  useEffect(() => {
    if (!activeTab) {
      setBacklinks([]);
      setUnlinked([]);
      return;
    }
    let cancelled = false;
    const name = noteName(activeTab);
    const id = window.setTimeout(() => {
      api.getBacklinks(name).then((b) => !cancelled && setBacklinks(b)).catch(() => {});
      api
        .getUnlinkedMentions(name)
        .then((u) => !cancelled && setUnlinked(u))
        .catch(() => {});
    }, 200);
    return () => {
      cancelled = true;
      window.clearTimeout(id);
    };
  }, [activeTab]);

  // Outgoing links parsed from the note body, resolved to paths.
  useEffect(() => {
    let cancelled = false;
    const names = Array.from(
      new Set(Array.from(content.matchAll(WIKILINK_RE)).map((m) => m[1].trim()))
    );
    Promise.all(
      names.map((n) => api.resolveLink(n).then((path) => ({ name: n, path })).catch(() => ({ name: n, path: null })))
    ).then((res) => !cancelled && setOutgoing(res));
    return () => {
      cancelled = true;
    };
  }, [content]);

  if (!activeTab) return <Empty>No note open.</Empty>;

  return (
    <div className="px-2 py-2">
      <Section title="Backlinks">
        {backlinks.length === 0 && <Empty>No backlinks.</Empty>}
        {backlinks.map((bl) => (
          <LinkRow key={bl.path} title={bl.title} sub={bl.snippet} onClick={() => openNote(bl.path)} />
        ))}
      </Section>

      <Section title="Outgoing links">
        {outgoing.length === 0 && <Empty>No outgoing links.</Empty>}
        {outgoing.map((o) => (
          <button
            key={o.name}
            onClick={() => o.path && openNote(o.path)}
            disabled={!o.path}
            className={`block w-full truncate rounded p-1.5 text-left text-sm ${
              o.path
                ? "text-[var(--onyx-accent)] hover:bg-black/5 dark:hover:bg-white/5"
                : "text-neutral-400"
            }`}
          >
            {o.name}
            {!o.path && " (missing)"}
          </button>
        ))}
      </Section>

      <Section title="Unlinked mentions">
        {unlinked.length === 0 && <Empty>None.</Empty>}
        {unlinked.map((u) => (
          <LinkRow key={u.path} title={u.title} sub={u.snippet} onClick={() => openNote(u.path)} />
        ))}
      </Section>
    </div>
  );
}

// ---- Outline ----

function OutlineTab({ content }: { content: string }) {
  const headings = Array.from(content.matchAll(/^(#{1,6})\s+(.*)$/gm)).map((m) => ({
    level: m[1].length,
    text: m[2].trim(),
  }));
  if (headings.length === 0) return <Empty>No headings.</Empty>;
  return (
    <div className="px-2 py-2">
      {headings.map((h, i) => (
        <button
          key={i}
          onClick={() => scrollToHeading(h.text)}
          style={{ paddingLeft: `${(h.level - 1) * 12 + 6}px` }}
          className="block w-full truncate rounded py-1 pr-2 text-left text-sm text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5"
        >
          {h.text}
        </button>
      ))}
    </div>
  );
}

// ---- Tags ----

function TagsTab() {
  const openNote = useStore((s) => s.openNote);
  const [tags, setTags] = useState<[string, number][]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    api.getTags().then(setTags).catch(() => setTags([]));
  }, []);

  const toggle = (tag: string) => {
    if (expanded === tag) return setExpanded(null);
    setExpanded(tag);
    api.getNotesByTag(tag).then(setNotes).catch(() => setNotes([]));
  };

  if (tags.length === 0) return <Empty>No tags in this vault.</Empty>;
  return (
    <div className="px-2 py-2">
      {tags.map(([tag, count]) => (
        <div key={tag}>
          <button
            onClick={() => toggle(tag)}
            className="flex w-full items-center justify-between rounded px-2 py-1 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5"
          >
            <span className="truncate text-[#56b6c2]">#{tag}</span>
            <span className="text-xs text-neutral-400">{count}</span>
          </button>
          {expanded === tag &&
            notes.map((p) => (
              <button
                key={p}
                onClick={() => openNote(p)}
                className="block w-full truncate rounded py-1 pl-5 pr-2 text-left text-xs text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5"
              >
                {noteName(p)}
              </button>
            ))}
        </div>
      ))}
    </div>
  );
}

// ---- Bookmarks ----

function BookmarksTab() {
  const bookmarks = useStore((s) => s.bookmarks);
  const activeTab = useStore((s) => s.activeTab);
  const openNote = useStore((s) => s.openNote);
  const toggleBookmark = useStore((s) => s.toggleBookmark);

  return (
    <div className="px-2 py-2">
      {activeTab && (
        <button
          onClick={() => toggleBookmark(activeTab)}
          className="mb-2 w-full rounded-md bg-black/5 px-2 py-1 text-xs text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200"
        >
          {bookmarks.includes(activeTab) ? "★ Remove current note" : "☆ Bookmark current note"}
        </button>
      )}
      {bookmarks.length === 0 && <Empty>No bookmarks yet.</Empty>}
      {bookmarks.map((p) => (
        <div key={p} className="group flex items-center">
          <button
            onClick={() => openNote(p)}
            className="flex-1 truncate rounded p-1.5 text-left text-sm text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/5"
          >
            {noteName(p)}
          </button>
          <button
            onClick={() => toggleBookmark(p)}
            className="px-1.5 text-xs text-neutral-400 opacity-0 group-hover:opacity-100"
            title="Remove"
          >
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

// ---- AI Assist (unchanged behavior) ----

function AiAssist({ activeTab }: { activeTab: string | null }) {
  const openNote = useStore((s) => s.openNote);
  const [tags, setTags] = useState<string[] | null>(null);
  const [links, setLinks] = useState<LinkSuggestion[] | null>(null);
  const [busy, setBusy] = useState<"tags" | "links" | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setTags(null);
    setLinks(null);
    setError(null);
  }, [activeTab]);

  if (!activeTab) return <Empty>No note open.</Empty>;

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
  const acceptLink = (s: LinkSuggestion) => {
    insertText(`[[${s.name}]]`);
    setLinks((prev) => prev?.filter((l) => l.path !== s.path) ?? null);
  };

  const btn =
    "rounded-md bg-black/5 px-2 py-1 text-xs text-neutral-700 hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/20";

  return (
    <div className="px-2 py-2">
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
        <div className="mb-3 flex flex-wrap gap-1.5">
          {tags.length === 0 && <Empty>No new tags suggested.</Empty>}
          {tags.map((t) => (
            <button
              key={t}
              onClick={() => acceptTag(t)}
              className="rounded-full bg-[var(--onyx-accent)]/15 px-2 py-0.5 text-xs text-[var(--onyx-accent)] hover:bg-[var(--onyx-accent)]/25"
            >
              #{t} +
            </button>
          ))}
        </div>
      )}
      {links &&
        (links.length === 0 ? (
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
                  className="shrink-0 rounded bg-black/5 px-1.5 text-xs text-neutral-600 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-300"
                >
                  Insert
                </button>
              </div>
              {s.reason && <p className="mt-0.5 text-xs text-neutral-400">{s.reason}</p>}
            </div>
          ))
        ))}
    </div>
  );
}

// ---- shared bits ----

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="mb-3">
      <div className="px-1 py-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
        {title}
      </div>
      {children}
    </div>
  );
}

function LinkRow({ title, sub, onClick }: { title: string; sub?: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="mb-1 block w-full rounded p-2 text-left hover:bg-black/5 dark:hover:bg-white/5"
    >
      <div className="truncate text-sm font-medium text-neutral-700 dark:text-neutral-200">
        {title}
      </div>
      {sub && <div className="truncate text-xs text-neutral-400">{sub}</div>}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-1 py-1 text-xs text-neutral-400">{children}</p>;
}
