import { noteName } from "../lib/api";
import { useStore } from "../state/store";

const MODE_LABEL: Record<string, string> = {
  source: "Source",
  live: "Live Preview",
  reading: "Reading",
};

export function StatusBar() {
  const vault = useStore((s) => s.vault);
  const activeTab = useStore((s) => s.activeTab);
  const stats = useStore((s) => s.editorStats);
  const mode = useStore((s) => (activeTab ? s.noteModes[activeTab] ?? "live" : null));

  return (
    <div className="flex h-6 shrink-0 items-center gap-4 border-t border-black/10 bg-neutral-50 px-3 text-xs text-neutral-500 dark:border-white/10 dark:bg-neutral-900">
      <span>{vault?.note_count ?? 0} notes</span>
      {activeTab && <span className="truncate">{noteName(activeTab)}</span>}
      <div className="flex-1" />
      {stats && (
        <span>
          {stats.words} words · {stats.chars} chars
        </span>
      )}
      {mode && <span>{MODE_LABEL[mode]}</span>}
    </div>
  );
}
