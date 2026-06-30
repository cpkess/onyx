import { useEffect } from "react";
import { listen } from "@tauri-apps/api/event";
import { api } from "./lib/api";
import { useStore } from "./state/store";
import { LeftSidebar } from "./components/LeftSidebar";
import { PaneView } from "./components/PaneView";
import { Sidebar } from "./components/Sidebar";
import { CommandPalette } from "./components/CommandPalette";
import { GraphView } from "./components/GraphView";
import { Settings } from "./components/Settings";
import { StatusBar } from "./components/StatusBar";
import { HoverPreview } from "./components/HoverPreview";
import { TemplatePicker } from "./components/TemplatePicker";
import { UpdateBanner } from "./components/UpdateBanner";
import { ImportDropZone } from "./components/ImportDropZone";
import { runHotkey } from "./commands/registry";
import { invalidatePages } from "./dataview/pages";

function Toolbar() {
  const vault = useStore((s) => s.vault);
  const openPalette = useStore((s) => s.openPalette);
  const setGraphOpen = useStore((s) => s.setGraphOpen);
  const setSettingsOpen = useStore((s) => s.setSettingsOpen);
  const toggleSidebar = useStore((s) => s.toggleSidebar);

  return (
    <div className="flex h-10 shrink-0 items-center gap-2 border-b border-black/10 bg-neutral-50 px-3 dark:border-white/10 dark:bg-neutral-900">
      <span className="font-semibold text-neutral-800 dark:text-neutral-100">
        Onyx
      </span>
      <span className="text-neutral-300 dark:text-neutral-600">/</span>
      <span className="truncate text-sm text-neutral-500">{vault?.name}</span>
      <div className="flex-1" />
      <button
        onClick={() => openPalette("files")}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="Quick open (⌘O) · Commands (⌘P)"
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
        onClick={() => setSettingsOpen(true)}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="Settings"
      >
        ⚙
      </button>
      <button
        onClick={toggleSidebar}
        className="rounded px-2 py-1 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        title="Toggle sidebar (⌘\)"
      >
        ⮞
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
  const panes = useStore((s) => s.panes);
  const sidebarOpen = useStore((s) => s.sidebarOpen);
  const initVault = useStore((s) => s.initVault);
  const refreshTree = useStore((s) => s.refreshTree);

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
      invalidatePages();
    });
    return () => {
      unlisten.then((fn) => fn());
    };
  }, [refreshTree]);

  // Global keyboard shortcuts via the command registry.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return; // already handled (e.g. CodeMirror ⌘F)
      if (runHotkey(e)) e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!vault) return <Welcome />;

  return (
    <div className="flex h-full flex-col bg-white text-neutral-900 dark:bg-neutral-900 dark:text-neutral-100">
      <Toolbar />
      <div className="flex min-h-0 flex-1">
        <aside className="w-60 shrink-0 overflow-hidden border-r border-black/10 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900">
          <LeftSidebar />
        </aside>
        <main className="flex min-w-0 flex-1">
          {panes.map((p, i) => (
            <PaneView key={p.id} pane={p} showSplitBorder={i > 0} />
          ))}
        </main>
        {sidebarOpen && (
          <aside className="w-72 shrink-0 overflow-hidden border-l border-black/10 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900">
            <Sidebar />
          </aside>
        )}
      </div>
      <StatusBar />
      <CommandPalette />
      <GraphView />
      <Settings />
      <TemplatePicker />
      <HoverPreview />
      <UpdateBanner />
      <ImportDropZone />
    </div>
  );
}
