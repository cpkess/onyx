import { create } from "zustand";
import { api, pickVaultFolder, type TreeNode, type VaultInfo } from "../lib/api";

type Theme = "dark" | "light";

interface AppStore {
  vault: VaultInfo | null;
  tree: TreeNode[];
  tabs: string[]; // open note paths
  activeTab: string | null;
  theme: Theme;
  paletteOpen: boolean;
  graphOpen: boolean;
  settingsOpen: boolean;
  chatOpen: boolean;
  aiToolsOpen: boolean;
  loading: boolean;

  initVault: () => Promise<void>;
  chooseVault: () => Promise<void>;
  openVaultPath: (path: string) => Promise<void>;
  refreshTree: () => Promise<void>;
  openNote: (path: string) => void;
  closeTab: (path: string) => void;
  setActive: (path: string) => void;
  createAndOpen: (path: string) => Promise<void>;
  createFolder: (path: string) => Promise<void>;
  movePath: (src: string, destDir: string) => Promise<void>;
  toggleTheme: () => void;
  setPaletteOpen: (open: boolean) => void;
  setGraphOpen: (open: boolean) => void;
  setSettingsOpen: (open: boolean) => void;
  setChatOpen: (open: boolean) => void;
  setAiToolsOpen: (open: boolean) => void;
}

// Module-level guard so the vault is auto-opened at most once per session.
let vaultInitStarted = false;

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
}

const initialTheme: Theme =
  (localStorage.getItem("onyx-theme") as Theme | null) ?? "dark";
applyTheme(initialTheme);

export const useStore = create<AppStore>((set, get) => ({
  vault: null,
  tree: [],
  tabs: [],
  activeTab: null,
  theme: initialTheme,
  paletteOpen: false,
  graphOpen: false,
  settingsOpen: false,
  chatOpen: false,
  aiToolsOpen: false,
  loading: false,

  initVault: async () => {
    // Guard against repeated invocation (StrictMode / re-renders): only the
    // first call ever opens the last vault.
    if (vaultInitStarted) return;
    vaultInitStarted = true;
    const last = await api.getLastVault();
    if (last) {
      await get().openVaultPath(last);
    }
  },

  chooseVault: async () => {
    const path = await pickVaultFolder();
    if (path) await get().openVaultPath(path);
  },

  openVaultPath: async (path: string) => {
    set({ loading: true });
    try {
      const vault = await api.openVault(path);
      set({
        vault,
        tree: vault.tree,
        tabs: [],
        activeTab: null,
      });
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
      const tree = await api.getTree();
      set({ tree });
    } catch (e) {
      console.error("refreshTree failed", e);
    }
  },

  openNote: (path: string) => {
    const { tabs } = get();
    set({
      tabs: tabs.includes(path) ? tabs : [...tabs, path],
      activeTab: path,
    });
  },

  closeTab: (path: string) => {
    const { tabs, activeTab } = get();
    const idx = tabs.indexOf(path);
    const next = tabs.filter((t) => t !== path);
    let newActive = activeTab;
    if (activeTab === path) {
      newActive = next[Math.min(idx, next.length - 1)] ?? null;
    }
    set({ tabs: next, activeTab: newActive });
  },

  setActive: (path: string) => set({ activeTab: path }),

  createAndOpen: async (path: string) => {
    try {
      const rel = await api.createNote(path);
      await get().refreshTree();
      get().openNote(rel);
    } catch (e) {
      console.error("createNote failed", e);
      alert(`Failed to create note: ${e}`);
    }
  },

  createFolder: async (path: string) => {
    try {
      await api.createFolder(path);
      await get().refreshTree();
    } catch (e) {
      console.error("createFolder failed", e);
      alert(`Failed to create folder: ${e}`);
    }
  },

  movePath: async (src: string, destDir: string) => {
    try {
      const newPath = await api.movePath(src, destDir);
      if (newPath === src) return;
      await get().refreshTree();
      // Remap any open tabs (the moved note, or notes under a moved folder).
      const remap = (p: string): string => {
        if (p === src) return newPath;
        if (p.startsWith(src + "/")) return newPath + p.slice(src.length);
        return p;
      };
      const { tabs, activeTab } = get();
      set({
        tabs: tabs.map(remap),
        activeTab: activeTab ? remap(activeTab) : activeTab,
      });
    } catch (e) {
      console.error("move failed", e);
      alert(`Could not move: ${e}`);
    }
  },

  toggleTheme: () => {
    const theme: Theme = get().theme === "dark" ? "light" : "dark";
    localStorage.setItem("onyx-theme", theme);
    applyTheme(theme);
    set({ theme });
  },

  setPaletteOpen: (open) => set({ paletteOpen: open }),
  setGraphOpen: (open) => set({ graphOpen: open }),
  setSettingsOpen: (open) => set({ settingsOpen: open }),
  setChatOpen: (open) => set({ chatOpen: open }),
  setAiToolsOpen: (open) => set({ aiToolsOpen: open }),
}));
