import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { formatDate, type Settings } from "../settings";
import { getCachedPages, ensurePages, onPagesChanged } from "../dataview/pages";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];
const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

function dailyPath(date: Date, s: Settings): string {
  const folder = s.dailyFolder.trim().replace(/\/+$/, "");
  const fname = formatDate(s.dailyFormat || "YYYY-MM-DD", date);
  return `${folder ? folder + "/" : ""}${fname}.md`;
}

/** 1–3 density dots scaled by note byte size (proxy for length). */
function dotCount(size: number): number {
  return size >= 1800 ? 3 : size >= 600 ? 2 : 1;
}

function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

export function CalendarTab() {
  const settings = useStore((s) => s.settings);
  const activeTab = useStore((s) => s.activeTab);
  const openDailyNote = useStore((s) => s.openDailyNote);
  const tree = useStore((s) => s.tree); // re-render on vault changes
  const [view, setView] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [pv, setPv] = useState(0); // bumps when the pages cache changes

  useEffect(() => {
    ensurePages();
    return onPagesChanged(() => setPv((v) => v + 1));
  }, []);

  // Map daily-note path → byte size, for existence + density dots.
  const sizes = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of getCachedPages()) map.set(p.path, p.size);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pv, tree]);

  const ws = settings.weekStart;
  const weekdays = useMemo(
    () => Array.from({ length: 7 }, (_, i) => WEEKDAYS[(i + ws) % 7]),
    [ws]
  );

  const today = new Date();
  const first = new Date(view.y, view.m, 1);
  const startOffset = (first.getDay() - ws + 7) % 7;
  const gridStart = new Date(view.y, view.m, 1 - startOffset);
  const cells = Array.from(
    { length: 42 },
    (_, i) => new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)
  );

  const shiftMonth = (delta: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const goToday = () => setView({ y: today.getFullYear(), m: today.getMonth() });

  const navBtn =
    "rounded px-1.5 py-0.5 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10";

  return (
    <div className="px-2 py-2 text-xs">
      {/* Header: prev · month/year · next · today */}
      <div className="mb-1 flex items-center justify-between">
        <button className={navBtn} title="Previous month" onClick={() => shiftMonth(-1)}>
          ‹
        </button>
        <button
          className="rounded px-2 py-0.5 text-sm font-medium text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/10"
          title="Jump to today"
          onClick={goToday}
        >
          {MONTHS[view.m]} {view.y}
        </button>
        <div className="flex items-center">
          <button className={navBtn} title="Next month" onClick={() => shiftMonth(1)}>
            ›
          </button>
          <button className={navBtn} title="Today" onClick={goToday}>
            ⊙
          </button>
        </div>
      </div>

      {/* Weekday header */}
      <div className="grid grid-cols-7 text-center text-[10px] uppercase tracking-wide text-neutral-400">
        {weekdays.map((w, i) => (
          <div key={i} className="py-1">
            {w}
          </div>
        ))}
      </div>

      {/* Day grid */}
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === view.m;
          const path = dailyPath(d, settings);
          const size = sizes.get(path);
          const has = size !== undefined;
          const active = activeTab === path;
          const isToday = sameDay(d, today);
          const dots = has ? dotCount(size as number) : 0;

          const cls = active
            ? "bg-[var(--onyx-accent)] text-white"
            : isToday
              ? "font-semibold text-[var(--onyx-accent)] ring-1 ring-[var(--onyx-accent)]/50"
              : inMonth
                ? "text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/10"
                : "text-neutral-300 hover:bg-black/5 dark:text-neutral-600 dark:hover:bg-white/10";

          return (
            <button
              key={i}
              onClick={() => openDailyNote(d)}
              title={path}
              className={`relative flex h-9 flex-col items-center justify-center rounded ${cls}`}
            >
              <span>{d.getDate()}</span>
              <span className="mt-0.5 flex h-1 items-center gap-0.5">
                {Array.from({ length: dots }, (_, k) => (
                  <span
                    key={k}
                    className={`h-1 w-1 rounded-full ${
                      active ? "bg-white/80" : "bg-[var(--onyx-accent)]"
                    }`}
                  />
                ))}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
