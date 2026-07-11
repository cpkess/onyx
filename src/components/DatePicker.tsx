import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { getCachedPages, ensurePages, onPagesChanged } from "../dataview/pages";
import { parseNaturalDate } from "../lib/dateParse";
import { MonthGrid } from "./MonthGrid";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/** "Go to date…" modal: type a natural-language date or pick a day to jump to
 *  (and create if needed) that day's journal. */
export function DatePicker() {
  const open = useStore((s) => s.datePickerOpen);
  const setOpen = useStore((s) => s.setDatePickerOpen);
  const settings = useStore((s) => s.settings);
  const activeTab = useStore((s) => s.activeTab);
  const openDailyNote = useStore((s) => s.openDailyNote);

  const [query, setQuery] = useState("");
  const [view, setView] = useState(() => {
    const n = new Date();
    return { y: n.getFullYear(), m: n.getMonth() };
  });
  const [pv, setPv] = useState(0);

  useEffect(() => {
    if (!open) return;
    ensurePages();
    return onPagesChanged(() => setPv((v) => v + 1));
  }, [open]);

  // Reset the query each time the modal opens.
  useEffect(() => {
    if (open) {
      setQuery("");
      const n = new Date();
      setView({ y: n.getFullYear(), m: n.getMonth() });
    }
  }, [open]);

  const sizes = useMemo(() => {
    const map = new Map<string, number>();
    for (const p of getCachedPages()) map.set(p.path, p.size);
    return map;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pv, open]);

  // Follow the typed date so the grid shows its month.
  const parsed = parseNaturalDate(query);
  const py = parsed?.getFullYear();
  const pm = parsed?.getMonth();
  useEffect(() => {
    if (py !== undefined && pm !== undefined) setView({ y: py, m: pm });
  }, [py, pm]);

  if (!open) return null;

  const go = (d: Date) => {
    openDailyNote(d);
    setOpen(false);
  };
  const shiftMonth = (delta: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });

  const navBtn =
    "rounded px-1.5 py-0.5 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[22rem] max-w-[90vw] overflow-hidden rounded-xl bg-white p-3 shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setOpen(false);
            else if (e.key === "Enter" && parsed) go(parsed);
          }}
          placeholder="Go to date… (today, tomorrow, jul 15, 2026-07-15)"
          className="mb-1 w-full rounded-md border border-black/10 bg-transparent px-3 py-2 text-sm outline-none placeholder:text-neutral-400 focus:border-[var(--onyx-accent)] dark:border-white/10"
        />
        <div className="mb-2 h-4 px-1 text-xs text-neutral-500">
          {query && parsed && (
            <span>
              ↵ Open journal for{" "}
              <span className="font-medium text-[var(--onyx-accent)]">
                {parsed.toDateString()}
              </span>
            </span>
          )}
          {query && !parsed && <span className="text-neutral-400">Not a date</span>}
        </div>

        <div className="mb-1 flex items-center justify-between text-xs">
          <button className={navBtn} title="Previous month" onClick={() => shiftMonth(-1)}>
            ‹
          </button>
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
            {MONTHS[view.m]} {view.y}
          </span>
          <button className={navBtn} title="Next month" onClick={() => shiftMonth(1)}>
            ›
          </button>
        </div>

        <MonthGrid
          view={view}
          settings={settings}
          sizes={sizes}
          activePath={activeTab}
          onPick={go}
        />
      </div>
    </div>
  );
}
