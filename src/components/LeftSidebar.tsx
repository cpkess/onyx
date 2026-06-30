import { useEffect, useState } from "react";
import { api, noteName } from "../lib/api";
import { useStore, type LeftTab } from "../state/store";
import { FileTree } from "./FileTree";
import { CalendarTab } from "./CalendarTab";

// The left rail is the "navigate / find" hub: a small view switcher above the
// content (Files · Bookmarks · Tags · Calendar).
export function LeftSidebar() {
  const tab = useStore((s) => s.leftTab);
  const setTab = useStore((s) => s.setLeftTab);

  const tabs: [LeftTab, string, string][] = [
    ["files", "Files", "Files"],
    ["bookmarks", "★", "Bookmarks"],
    ["tags", "#", "Tags"],
    ["calendar", "📅", "Calendar"],
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex shrink-0 border-b border-black/10 text-xs dark:border-white/10">
        {tabs.map(([t, label, title]) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            title={title}
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
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === "files" && <FileTree />}
        {tab === "bookmarks" && <BookmarksView />}
        {tab === "tags" && <TagsView />}
        {tab === "calendar" && <CalendarTab />}
      </div>
    </div>
  );
}

function TagsView() {
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

function BookmarksView() {
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

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-2 text-xs text-neutral-400">{children}</p>;
}
