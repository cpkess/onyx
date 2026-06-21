import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./lib/api";
import { useStore } from "./state/store";
import { FileTree } from "./components/FileTree";
import { TabBar } from "./components/TabBar";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { GraphView } from "./components/GraphView";
import { Settings } from "./components/Settings";
import { ChatPanel } from "./components/ChatPanel";
import { AiTools } from "./components/AiTools";
import { Editor } from "./editor/Editor";

function Toolbar() {
  const vault = useStore((s) => s.vault);
  const chooseVault = useStore((s) => s.chooseVault);
  const toggleTheme = useStore((s) => s.toggleTheme);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setGraphOpen = useStore((s) => s.setGraphOpen);
  const setChatOpen = useStore((s) => s.setChatOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const setAiToolsOpen = useStore((s) => s.setAiToolsOpen);
  const chatOpen = useStore((s) => s.chatOpen);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/10 bg-neutral-50 px-3 dark:border-white/10 dark:bg-neutral-900">
      <span className="font-semibold text-neutral-800 dark:text-neutral-100">
        Onyx
      </span>
      <span className="text-neutral-300 dark:text-neutral-600">/</span>
      <span className="truncate text-sm text-neutral-500">{vault?.name}</span>
      <div className="flex-1" />
      <button
        onClick={() => setPaletteOpen(true)}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="Quick open / search (⌘P)"
      >
        Search
      </button>
      <button
        onClick={() => setGraphOpen(true)}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="Graph view (⌘G)"
      >
        Graph
      </button>
      <button
        onClick={() => setChatOpen(!chatOpen)}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="AI chat (⌘J)"
      >
        AI Chat
      </button>
      <button
        onClick={() => setAiToolsOpen(true)}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="Synthesis & subject pages"
      >
        AI Tools
      </button>
      <button
        onClick={() => setSettingsOpen(true)}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="AI settings"
      >
        ⚙
      </button>
      <button
        onClick={toggleTheme}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="Toggle theme"
      >
        ◐
      </button>
      <button
        onClick={chooseVault}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
      >
        Change vault
      </button>
    </div>
  );
}

function Welcome() {
  const chooseVault = useStore((s) => s.chooseVault);
  return (
    <div className="flex h-full flex-col items-center justify-center gap-6 bg-white dark:bg-neutral-900">
      <div className="text-center">
        <h1 className="text-3xl font-bold text-neutral-800 dark:text-neutral-100">
          Onyx
        </h1>
        <p className="mt-2 text-neutral-500">
          An AI-augmented, local-first knowledge base.
        </p>
      </div>
      <button
        onClick={chooseVault}
        className="rounded-lg bg-[var(--onyx-accent)] px-5 py-2.5 font-medium text-white hover:opacity-90"
      >
        Open a vault folder…
      </button>
    </div>
  );
}

export default function App() {
  const vault = useStore((s) => s.vault);
  const activeTab = useStore((s) => s.activeTab);
  const initVault = useStore((s) => s.initVault);
  const refreshTree = useStore((s) => s.refreshTree);
  const setPaletteOpen = useStore((s) => s.setPaletteOpen);
  const setGraphOpen = useStore((s) => s.setGraphOpen);

  useEffect(() => {
    initVault();
  }, [initVault]);

  // Re-index + refresh the tree when the vault changes on disk.
  useEffect(() => {
    const unlisten = listen("vault-changed", async () => {
      try {
        await api.reindex();
      } catch {
        /* no vault open */
      }
      refreshTree();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshTree]);

  // Global keyboard shortcuts.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && (e.key === "p" || e.key === "k")) {
        e.preventDefault();
        setPaletteOpen(true);
      } else if (mod && e.key === "g") {
        e.preventDefault();
        setGraphOpen(true);
      } else if (mod && e.key === "j") {
        e.preventDefault();
        useStore.getState().setChatOpen(!useStore.getState().chatOpen);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, setGraphOpen]);

  if (!vault) return <Welcome />;

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-hidden border-r border-black/10 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900">
          <FileTree />
        </aside>
        <main className="flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950/40">
          <TabBar />
          <div className="min-h-0 flex-1">
            {activeTab ? (
              <Editor key={activeTab} path={activeTab} />
            ) : (
              <div className="flex h-full items-center justify-center text-sm text-neutral-400">
                Select a note, or press ⌘P to search.
              </div>
            )}
          </div>
        </main>
        <aside className="w-64 shrink-0 overflow-hidden border-l border-black/10 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900">
          <Sidebar />
        </aside>
        <ChatPanel />
      </div>
      <CommandPalette />
      <GraphView />
      <Settings />
      <AiTools />
    </div>
  );
}
