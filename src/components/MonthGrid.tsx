import { useMemo } from "react";
import { dailyRelPath, sameDay } from "../lib/daily";
import type { Settings } from "../settings";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];

/** 1–3 density dots scaled by note byte size (proxy for length). */
function dotCount(size: number): number {
  return size >= 1800 ? 3 : size >= 600 ? 2 : 1;
}

/**
 * A reusable month-grid calendar. Presentational: given a month view, the daily
 * settings (for path/week-start), a `sizes` map (daily-note path → byte size,
 * for existence + density dots), and the active note path, it renders the grid
 * and calls `onPick(date)` when a day is clicked. Used by the Calendar sidebar
 * tab and the Go-to-date picker.
 */
export function MonthGrid({
  view,
  settings,
  sizes,
  activePath,
  onPick,
}: {
  view: { y: number; m: number };
  settings: Settings;
  sizes: Map<string, number>;
  activePath?: string | null;
  onPick: (date: Date) => void;
}) {
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
    (_, i) =>
      new Date(gridStart.getFullYear(), gridStart.getMonth(), gridStart.getDate() + i)
  );

  return (
    <div>
      <div className="grid grid-cols-7 text-center text-[10px] uppercase tracking-wide text-neutral-400">
        {weekdays.map((w, i) => (
          <div key={i} className="py-1">
            {w}
          </div>
        ))}
      </div>
      <div className="grid grid-cols-7 gap-0.5">
        {cells.map((d, i) => {
          const inMonth = d.getMonth() === view.m;
          const path = dailyRelPath(d, settings);
          const size = sizes.get(path);
          const has = size !== undefined;
          const active = activePath === path;
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
              onClick={() => onPick(d)}
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
