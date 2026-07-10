import { openSearchPanel } from "@codemirror/search";
import { useStore } from "../state/store";
import {
  getActiveEditor,
  insertHcmBlock,
  wrapSelection,
  insertSnippet,
} from "../editor/activeEditor";
import { regenerateActivePage } from "../lib/regenerate";
import { composeActivePage } from "../lib/compose";
import { manualUpdateCheck } from "../lib/updater";
import { pickAndImport } from "../lib/importDoc";
import { api } from "../lib/api";
import { invalidatePages } from "../dataview/pages";
import { invalidateBlockRefs } from "../dataview/blockrefs";

export interface Command {
  id: string;
  name: string;
  /** Default hotkey combo, e.g. "mod+p". */
  keys?: string;
  run: () => void;
}

const s = () => useStore.getState();

export const commands: Command[] = [
  { id: "command-palette", name: "Open command palette", keys: "mod+p", run: () => s().openPalette("commands") },
  { id: "quick-open", name: "Quick switcher: open note", keys: "mod+o", run: () => s().openPalette("files") },
  { id: "search-vault", name: "Search vault", keys: "mod+shift+f", run: () => s().openPalette("files") },
  { id: "new-note", name: "Create new note", keys: "mod+n", run: () => void s().newNote() },
  { id: "daily-note", name: "Open today's daily note", keys: "mod+d", run: () => void s().openDailyNote() },
  { id: "insert-template", name: "Insert template…", run: () => s().setTemplatePickerOpen(true) },
  {
    id: "reindex-vault",
    name: "Reindex vault (rebuild links, blocks & references)",
    run: () => {
      void api
        .reindex()
        .then(() => {
          invalidatePages();
          invalidateBlockRefs();
        })
        .catch((e) => console.error("reindex failed", e));
    },
  },
  {
    id: "toggle-bookmark",
    name: "Bookmark / unbookmark current note",
    run: () => {
      const { activeTab, toggleBookmark } = s();
      if (activeTab) toggleBookmark(activeTab);
    },
  },
  {
    id: "cycle-mode",
    name: "Toggle edit / reading view",
    keys: "mod+e",
    run: () => {
      const { activeTab, cycleNoteMode } = s();
      if (activeTab) cycleNoteMode(activeTab);
    },
  },
  { id: "split-right", name: "Split editor right", keys: "mod+\\", run: () => s().splitActivePane() },
  {
    id: "find-in-note",
    name: "Find / replace in current note",
    keys: "mod+f",
    run: () => {
      const v = getActiveEditor();
      if (v) {
        openSearchPanel(v);
        v.focus();
      }
    },
  },
  { id: "graph", name: "Open graph view", keys: "mod+g", run: () => s().setGraphOpen(true) },
  {
    id: "open-calendar",
    name: "Open calendar",
    keys: "mod+shift+c",
    run: () => s().setLeftTab("calendar"),
  },
  {
    id: "toggle-sidebar",
    name: "Toggle sidebar",
    keys: "mod+\\",
    run: () => s().toggleSidebar(),
  },
  { id: "ai-chat", name: "AI chat", keys: "mod+j", run: () => s().openAiTool("chat") },
  { id: "ai-tools", name: "AI tools (synthesis, subject pages)", run: () => s().openAiTool("tools") },
  {
    id: "ai-regenerate",
    name: "AI: Regenerate this page from vault",
    run: () => {
      regenerateActivePage().catch((e) => console.error("regenerate failed", e));
    },
  },
  {
    id: "ai-compose",
    name: "AI: Compose sections from AI context (HCM)",
    run: () => {
      composeActivePage().catch((e) => console.error("compose failed", e));
    },
  },
  {
    id: "hcm-insert",
    name: "Insert AI context block (HCM)",
    run: () => insertHcmBlock(),
  },
  {
    id: "toggle-toolbar",
    name: "Toggle formatting toolbar",
    keys: "mod+shift+b",
    run: () =>
      s().setSettings({ showFormattingToolbar: !s().settings.showFormattingToolbar }),
  },
  { id: "format-bold", name: "Format: bold", keys: "mod+b", run: () => wrapSelection("**") },
  { id: "format-italic", name: "Format: italic", keys: "mod+i", run: () => wrapSelection("*") },
  {
    id: "insert-wikilink",
    name: "Insert wikilink [[ ]]",
    keys: "mod+shift+k",
    run: () => insertSnippet("[[]]", 2),
  },
  {
    id: "streamweaver",
    name: "StreamWeaver: weave current note",
    keys: "mod+shift+w",
    run: () => s().openAiTool("weave"),
  },
  { id: "settings", name: "Open settings", keys: "mod+,", run: () => s().setSettingsOpen(true) },
  { id: "check-updates", name: "Check for updates", run: () => void manualUpdateCheck() },
  {
    id: "import-document",
    name: "Import document…",
    run: () => {
      pickAndImport().then((rel) => {
        if (rel) {
          void s().refreshTree();
          s().openNote(rel);
        }
      }).catch((e) => console.error("import failed", e));
    },
  },
  { id: "toggle-theme", name: "Toggle dark / light theme", run: () => s().toggleTheme() },
];

/** Normalize a keyboard event to a combo string like "mod+shift+f". */
export function eventToCombo(e: KeyboardEvent): string | null {
  const key = e.key.toLowerCase();
  if (["control", "meta", "shift", "alt"].includes(key)) return null;
  const parts: string[] = [];
  if (e.metaKey || e.ctrlKey) parts.push("mod");
  if (e.altKey) parts.push("alt");
  if (e.shiftKey) parts.push("shift");
  parts.push(key === " " ? "space" : key);
  return parts.join("+");
}

let overrides: Record<string, string> = {};
let byKey = new Map<string, Command>();

function effective(c: Command): string | undefined {
  return overrides[c.id] ?? c.keys;
}
function rebuild() {
  byKey = new Map();
  for (const c of commands) {
    const k = effective(c);
    if (k) byKey.set(k, c);
  }
}
rebuild();

export function setHotkeyOverrides(o: Record<string, string>) {
  overrides = o ?? {};
  rebuild();
}

/** The effective (possibly overridden) hotkey for a command id. */
export function effectiveKeys(id: string): string | undefined {
  const c = commands.find((x) => x.id === id);
  return c ? effective(c) : undefined;
}

/** Run a command matching the event's hotkey. Returns true if one ran. */
export function runHotkey(e: KeyboardEvent): boolean {
  const combo = eventToCombo(e);
  if (!combo) return false;
  const cmd = byKey.get(combo);
  if (cmd) {
    cmd.run();
    return true;
  }
  return false;
}
