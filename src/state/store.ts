import { create } from "zustand";
import { api, pickVaultFolder, type TreeNode, type VaultInfo } from "../lib/api";
import type { EditorMode } from "../editor/render/core";
import {
  type Settings,
  defaultSettings,
  applyAppearance,
  formatDate,
  substituteTemplate,
} from "../settings";
import { setHotkeyOverrides } from "../commands/registry";
import { dailyRelPath } from "../lib/daily";
import { invalidatePages } from "../dataview/pages";
import { trackEvent } from "../features/night/track";
import {
  type Pane,
  type Workspace,
  activePane,
  closeInPane,
  closePane,
  emptyWorkspace,
  moveTab,
  openInPane,
  openToRight,
  removePathEverywhere,
  remapPaths,
  setActiveInPane,
  splitPane,
} from "./workspace";

type Theme = "dark" | "light";
export type PaletteMode = "files" | "commands" | "semantic" | "atoms";
export type SidebarTab = "note" | "assist" | "atoms" | "overnight";
export type LeftTab = "files" | "bookmarks" | "tags" | "calendar";
export type AiTool = "assist" | "chat" | "tools" | "weave";

interface AppStore {
  vault: VaultInfo | null;
  tree: TreeNode[];
  panes: Pane[];
  activePaneId: string;
  activeTab: string | null; // synced: the active pane's active tab
  recent: string[];
  theme: Theme;
  paletteOpen: boolean;
  paletteMode: PaletteMode;
  noteModes: Record<string, EditorMode>;
  editorStats: { words: number; chars: number } | null;
  settings: Settings;
  bookmarks: string[];
  templatePickerOpen: boolean;
  datePickerOpen: boolean;
  graphOpen: boolean;
  settingsOpen: boolean;
  sidebarOpen: boolean;
  sidebarTab: SidebarTab;
  leftTab: LeftTab;
  aiTool: AiTool;
  loading: boolean;

  initVault: () => Promise<void>;
  chooseVault: () => Promise<void>;
  openVaultPath: (path: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  // Pane / tab actions
  openNote: (path: string) => void;
  openNoteInPane: (paneId: string, path: string) => void;
  openNoteToRight: (path: string) => void;
  closeTab: (path: string) => void;
  closeTabInPane: (paneId: string, path: string) => void;
  setActive: (path: string) => void;
  setActiveInPane: (paneId: string, path: string) => void;
  setActivePane: (paneId: string) => void;
  splitActivePane: () => void;
  closePane: (paneId: string) => void;
  moveTabToPane: (path: string, from: string, to: string) => void;
  createAndOpen: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  movePath: (src: string, destDir: string) => Promise<void>;
  renamePath: (oldPath: string, newPath: string) => Promise<void>;
  deleteNote: (path: string) => Promise<void>;
  toggleTheme: () => void;
  setPaletteOpen: (open: boolean) => void;
  openPalette: (mode: PaletteMode) => void;
  setNoteMode: (path: string, mode: EditorMode) => void;
  cycleNoteMode: (path: string) => void;
  setEditorStats: (stats: { words: number; chars: number } | null) => void;
  setSettings: (partial: Partial<Settings>) => void;
  toggleBookmark: (path: string) => void;
  newNote: () => Promise<void>;
  openDailyNote: (date?: Date) => Promise<void>;
  setTemplatePickerOpen: (open: boolean) => void;
  setDatePickerOpen: (open: boolean) => void;
  setGraphOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setSidebarOpen: (open: boolean) => void;
  toggleSidebar: () => void;
  setSidebarTab: (tab: SidebarTab) => void;
  setLeftTab: (tab: LeftTab) => void;
  setAiTool: (tool: AiTool) => void;
  openAiTool: (tool: AiTool) => void;
}

let vaultInitStarted = false;
let persistTimer: number | undefined;

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

const initialTheme: Theme =
  (localStorage.getItem("onyx-theme") as Theme | null) ?? "dark";
applyTheme(initialTheme);
applyAppearance(defaultSettings);

export const useStore = create<AppStore>((set, get) => {
  const ws = (): Workspace => ({ panes: get().panes, activePaneId: get().activePaneId });

  const schedulePersist = () => {
    window.clearTimeout(persistTimer);
    persistTimer = window.setTimeout(() => {
      const { vault, panes, activePaneId, noteModes, recent } = get();
      if (!vault) return;
      api
        .writeVaultMeta(
          "workspace.json",
          JSON.stringify({ panes, activePaneId, noteModes, recent })
        )
        .catch(() => {});
    }, 500);
  };

  // Apply a new workspace and keep the synced activeTab; persist (debounced).
  const commit = (next: Workspace, persist = true) => {
    set({
      panes: next.panes,
      activePaneId: next.activePaneId,
      activeTab: activePane(next).activeTab,
    });
    if (persist) schedulePersist();
  };

  const pushRecent = (path: string) => {
    set((s) => ({ recent: [path, ...s.recent.filter((p) => p !== path)].slice(0, 30) }));
  };

  const empty = emptyWorkspace();

  return {
    vault: null,
    tree: [],
    panes: empty.panes,
    activePaneId: empty.activePaneId,
    activeTab: null,
    recent: [],
    theme: initialTheme,
    paletteOpen: false,
    paletteMode: "files",
    noteModes: {},
    editorStats: null,
    settings: defaultSettings,
    bookmarks: [],
    templatePickerOpen: false,
    datePickerOpen: false,
    graphOpen: false,
    settingsOpen: false,
    sidebarOpen: true,
    sidebarTab: "note",
    leftTab: "files",
    aiTool: "assist",
    loading: false,

    initVault: async () => {
      if (vaultInitStarted) return;
      vaultInitStarted = true;
      const last = await api.getLastVault();
      if (last) await get().openVaultPath(last);
    },

    chooseVault: async () => {
      const path = await pickVaultFolder();
      if (path) await get().openVaultPath(path);
    },

    openVaultPath: async (path: string) => {
      set({ loading: true });
      try {
        const vault = await api.openVault(path);
        const fresh = emptyWorkspace();
        set({ vault, tree: vault.tree, noteModes: {}, recent: [] });
        commit(fresh, false);
        // Restore the saved workspace for this vault, if any.
        try {
          const raw = await api.readVaultMeta("workspace.json");
          if (raw) {
            const saved = JSON.parse(raw) as Partial<{
              panes: Pane[];
              activePaneId: string;
              noteModes: Record<string, EditorMode>;
              recent: string[];
            }>;
            if (saved.panes?.length) {
              set({ noteModes: saved.noteModes ?? {}, recent: saved.recent ?? [] });
              // Normalize legacy multi-tab panes to one file per pane.
              const panes = saved.panes.map((p) => ({
                ...p,
                tabs: p.activeTab ? [p.activeTab] : [],
              }));
              commit(
                {
                  panes,
                  activePaneId: saved.activePaneId ?? panes[0].id,
                },
                false
              );
            }
          }
        } catch {
          /* ignore corrupt workspace */
        }
        // Restore per-vault settings + bookmarks.
        try {
          const sraw = await api.readVaultMeta("settings.json");
          const settings: Settings = sraw
            ? { ...defaultSettings, ...JSON.parse(sraw) }
            : defaultSettings;
          applyAppearance(settings);
          setHotkeyOverrides(settings.hotkeys ?? {});
          set({ settings });
        } catch {
          applyAppearance(defaultSettings);
          set({ settings: defaultSettings });
        }
        try {
          const braw = await api.readVaultMeta("bookmarks.json");
          set({ bookmarks: braw ? JSON.parse(braw) : [] });
        } catch {
          set({ bookmarks: [] });
        }
      } catch (e) {
        console.error("Failed to open vault:", e);
        alert(`Failed to open vault: ${e}`);
      } finally {
        set({ loading: false });
      }
    },

    refreshTree: async () => {
      if (!get().vault) return;
      try {
        set({ tree: await api.getTree() });
      } catch (e) {
        console.error("refreshTree failed", e);
      }
    },

    openNote: (path) => {
      commit(openInPane(ws(), get().activePaneId, path));
      pushRecent(path);
      trackEvent("OPEN_NOTE", path);
    },
    openNoteToRight: (path) => {
      commit(openToRight(ws(), path));
      pushRecent(path);
    },
    openNoteInPane: (paneId, path) => {
      commit(openInPane(ws(), paneId, path));
      pushRecent(path);
    },
    closeTab: (path) => commit(closeInPane(ws(), get().activePaneId, path)),
    closeTabInPane: (paneId, path) => commit(closeInPane(ws(), paneId, path)),
    setActive: (path) => commit(setActiveInPane(ws(), get().activePaneId, path)),
    setActiveInPane: (paneId, path) => commit(setActiveInPane(ws(), paneId, path)),
    setActivePane: (paneId) => {
      if (get().activePaneId !== paneId) commit({ ...ws(), activePaneId: paneId });
    },
    splitActivePane: () => commit(splitPane(ws(), get().activePaneId)),
    closePane: (paneId) => commit(closePane(ws(), paneId)),
    moveTabToPane: (path, from, to) => commit(moveTab(ws(), path, from, to)),

    createAndOpen: async (path) => {
      try {
        const rel = await api.createNote(path);
        trackEvent("CREATE_NOTE", rel);
        await get().refreshTree();
        get().openNote(rel);
      } catch (e) {
        console.error("createNote failed", e);
        alert(`Failed to create note: ${e}`);
      }
    },

    createFolder: async (path) => {
      try {
        await api.createFolder(path);
        await get().refreshTree();
      } catch (e) {
        console.error("createFolder failed", e);
        alert(`Failed to create folder: ${e}`);
      }
    },

    movePath: async (src, destDir) => {
      try {
        const newPath = await api.movePath(src, destDir);
        if (newPath === src) return;
        await get().refreshTree();
        const remap = (p: string): string =>
          p === src ? newPath : p.startsWith(src + "/") ? newPath + p.slice(src.length) : p;
        commit(remapPaths(ws(), remap));
      } catch (e) {
        console.error("move failed", e);
        alert(`Could not move: ${e}`);
      }
    },

    renamePath: async (oldPath, newPath) => {
      try {
        const finalPath = await api.renamePath(oldPath, newPath);
        if (finalPath === oldPath) return;
        await get().refreshTree();
        const remap = (p: string): string =>
          p === oldPath
            ? finalPath
            : p.startsWith(oldPath + "/")
              ? finalPath + p.slice(oldPath.length)
              : p;
        commit(remapPaths(ws(), remap));
      } catch (e) {
        console.error("rename failed", e);
        alert(`Could not rename: ${e}`);
      }
    },

    deleteNote: async (path) => {
      try {
        await api.deleteNote(path);
        trackEvent("DELETE_NOTE", path);
        commit(removePathEverywhere(ws(), path));
        await get().refreshTree();
      } catch (e) {
        console.error("delete failed", e);
        alert(`Could not delete: ${e}`);
      }
    },

    toggleTheme: () => {
      const theme: Theme = get().theme === "dark" ? "light" : "dark";
      localStorage.setItem("onyx-theme", theme);
      applyTheme(theme);
      set({ theme });
    },

    setPaletteOpen: (open) => set({ paletteOpen: open }),
    openPalette: (mode) => set({ paletteMode: mode, paletteOpen: true }),
    setNoteMode: (path, mode) => {
      set((s) => ({ noteModes: { ...s.noteModes, [path]: mode } }));
      schedulePersist();
    },
    cycleNoteMode: (path) => {
      set((s) => {
        const order: EditorMode[] = ["source", "live", "reading"];
        const cur = s.noteModes[path] ?? "live";
        const next = order[(order.indexOf(cur) + 1) % order.length];
        return { noteModes: { ...s.noteModes, [path]: next } };
      });
      schedulePersist();
    },
    setEditorStats: (stats) => set({ editorStats: stats }),

    setSettings: (partial) => {
      const settings = { ...get().settings, ...partial };
      set({ settings });
      applyAppearance(settings);
      setHotkeyOverrides(settings.hotkeys ?? {});
      api.writeVaultMeta("settings.json", JSON.stringify(settings)).catch(() => {});
    },

    toggleBookmark: (path) => {
      const cur = get().bookmarks;
      const bookmarks = cur.includes(path) ? cur.filter((p) => p !== path) : [...cur, path];
      set({ bookmarks });
      api.writeVaultMeta("bookmarks.json", JSON.stringify(bookmarks)).catch(() => {});
    },

    newNote: async () => {
      const folder = get().settings.newNoteFolder.trim().replace(/\/+$/, "");
      await get().createAndOpen(folder ? `${folder}/Untitled` : "Untitled");
    },

    openDailyNote: async (date = new Date()) => {
      const s2 = get().settings;
      const fname = formatDate(s2.dailyFormat || "YYYY-MM-DD", date);
      const existing = await api.resolveLink(fname).catch(() => null);
      if (existing) return get().openNote(existing);
      let content = "";
      if (s2.dailyTemplate) {
        const t = await api.readNote(s2.dailyTemplate).catch(() => "");
        content = substituteTemplate(t, fname);
      }
      const rel = dailyRelPath(date, s2);
      try {
        const newRel = await api.createNoteWithContent(rel, content);
        await get().refreshTree();
        invalidatePages();
        get().openNote(newRel);
      } catch (e) {
        alert(`Could not create daily note: ${e}`);
      }
    },

    setTemplatePickerOpen: (open) => set({ templatePickerOpen: open }),
    setDatePickerOpen: (open) => set({ datePickerOpen: open }),

    setGraphOpen: (open) => set({ graphOpen: open }),
    setSettingsOpen: (open) => set({ settingsOpen: open }),
    setSidebarOpen: (open) => set({ sidebarOpen: open }),
    toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
    setSidebarTab: (tab) => set({ sidebarTab: tab }),
    setLeftTab: (tab) => set({ leftTab: tab }),
    setAiTool: (tool) => set({ aiTool: tool }),
    openAiTool: (tool) =>
      set({ sidebarOpen: true, sidebarTab: "assist", aiTool: tool }),
  };
});
