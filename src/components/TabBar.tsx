import { useState } from "react";
import { noteName } from "../lib/api";
import { useStore } from "../state/store";
import type { Pane } from "../state/workspace";
import { ContextMenu, type MenuState } from "./ContextMenu";

export function TabBar({ pane }: { pane: Pane }) {
  const setActiveInPane = useStore((s) => s.setActiveInPane);
  const closeTabInPane = useStore((s) => s.closeTabInPane);
  const splitActivePane = useStore((s) => s.splitActivePane);
  const setActivePane = useStore((s) => s.setActivePane);
  const [menu, setMenu] = useState<MenuState | null>(null);

  const onContext = (e: React.MouseEvent, path: string) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      items: [
        { label: "Close", onClick: () => closeTabInPane(pane.id, path) },
        {
          label: "Close others",
          onClick: () =>
            pane.tabs.filter((t) => t !== path).forEach((t) => closeTabInPane(pane.id, t)),
        },
        {
          label: "Split right",
          onClick: () => {
            setActivePane(pane.id);
            setActiveInPane(pane.id, path);
            splitActivePane();
          },
        },
      ],
    });
  };

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-black/10 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900">
      {pane.tabs.map((path) => {
        const isActive = path === pane.activeTab;
        return (
          <div
            key={path}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(
                "application/onyx-tab",
                JSON.stringify({ path, from: pane.id })
              );
              e.dataTransfer.effectAllowed = "move";
            }}
            onClick={() => setActiveInPane(pane.id, path)}
            onContextMenu={(e) => onContext(e, path)}
            className={`group flex cursor-pointer items-center gap-2 border-r border-black/10 px-3 text-sm dark:border-white/10 ${
              isActive
                ? "bg-white text-neutral-900 dark:bg-neutral-800 dark:text-white"
                : "text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5"
            }`}
          >
            <span className="max-w-[12rem] truncate">{noteName(path)}</span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                closeTabInPane(pane.id, path);
              }}
              className="rounded px-1 leading-none text-neutral-400 opacity-0 hover:bg-black/10 group-hover:opacity-100 dark:hover:bg-white/10"
            >
              ×
            </button>
          </div>
        );
      })}
      <ContextMenu menu={menu} onClose={() => setMenu(null)} />
    </div>
  );
}
