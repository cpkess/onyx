import { useState } from "react";
import { useStore } from "../state/store";
import type { Pane } from "../state/workspace";
import { TabBar } from "./TabBar";
import { Editor } from "../editor/Editor";

export function PaneView({ pane, showSplitBorder }: { pane: Pane; showSplitBorder: boolean }) {
  const activePaneId = useStore((s) => s.activePaneId);
  const setActivePane = useStore((s) => s.setActivePane);
  const moveTabToPane = useStore((s) => s.moveTabToPane);
  const closePane = useStore((s) => s.closePane);
  const panesCount = useStore((s) => s.panes.length);
  const [dragOver, setDragOver] = useState(false);
  const isActive = pane.id === activePaneId;

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes("application/onyx-tab")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setDragOver(true);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    const raw = e.dataTransfer.getData("application/onyx-tab");
    setDragOver(false);
    if (!raw) return;
    e.preventDefault();
    try {
      const { path, from } = JSON.parse(raw) as { path: string; from: string };
      moveTabToPane(path, from, pane.id);
    } catch {
      /* ignore */
    }
  };

  return (
    <div
      onMouseDownCapture={() => !isActive && setActivePane(pane.id)}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      className={`relative flex min-w-0 flex-1 flex-col bg-white dark:bg-neutral-950/40 ${
        showSplitBorder ? "border-l border-black/10 dark:border-white/10" : ""
      } ${dragOver ? "ring-2 ring-inset ring-[var(--onyx-accent)]/50" : ""}`}
    >
      {panesCount > 1 && (
        <div
          className={`pointer-events-none absolute right-1 top-1 z-10 h-1.5 w-1.5 rounded-full ${
            isActive ? "bg-[var(--onyx-accent)]" : "bg-transparent"
          }`}
        />
      )}
      {panesCount > 1 && (
        <button
          onClick={() => closePane(pane.id)}
          title="Close pane"
          className="absolute right-2 top-1.5 z-10 rounded px-1 text-xs text-neutral-400 hover:bg-black/10 dark:hover:bg-white/10"
        >
          ⤬
        </button>
      )}
      <TabBar pane={pane} />
      <div className="min-h-0 flex-1">
        {pane.activeTab ? (
          <Editor key={`${pane.id}:${pane.activeTab}`} path={pane.activeTab} paneId={pane.id} />
        ) : (
          <div className="flex h-full items-center justify-center text-sm text-neutral-400">
            Select a note, or press ⌘O.
          </div>
        )}
      </div>
    </div>
  );
}
