import { noteName } from "../lib/api";
import { useStore } from "../state/store";

export function TabBar() {
  const tabs = useStore((s) => s.tabs);
  const activeTab = useStore((s) => s.activeTab);
  const setActive = useStore((s) => s.setActive);
  const closeTab = useStore((s) => s.closeTab);

  if (tabs.length === 0) return null;

  return (
    <div className="flex h-9 shrink-0 items-stretch overflow-x-auto border-b border-black/10 bg-neutral-50 dark:border-white/10 dark:bg-neutral-900">
      {tabs.map((path) => {
        const isActive = path === activeTab;
        return (
          <div
            key={path}
            onClick={() => setActive(path)}
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
                closeTab(path);
              }}
              className="rounded px-1 leading-none text-neutral-400 opacity-0 hover:bg-black/10 group-hover:opacity-100 dark:hover:bg-white/10"
            >
              ×
            </button>
          </div>
        );
      })}
    </div>
  );
}
