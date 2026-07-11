import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { getCachedPages, ensurePages, onPagesChanged } from "../dataview/pages";
import { parseNaturalDate } from "../lib/dateParse";
import { MonthGrid } from "./MonthGrid";

const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

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
  const [jump, setJump] = useState("");

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

  const today = new Date();
  const shiftMonth = (delta: number) =>
    setView((v) => {
      const d = new Date(v.y, v.m + delta, 1);
      return { y: d.getFullYear(), m: d.getMonth() };
    });
  const goToday = () => setView({ y: today.getFullYear(), m: today.getMonth() });

  const submitJump = () => {
    const d = parseNaturalDate(jump);
    if (d) {
      setView({ y: d.getFullYear(), m: d.getMonth() });
      openDailyNote(d);
      setJump("");
    }
  };

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

      {/* Jump to a date (natural language) */}
      <input
        value={jump}
        onChange={(e) => setJump(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") submitJump();
        }}
        placeholder="Jump to… (e.g. tomorrow, jul 15)"
        className="mb-2 w-full rounded border border-black/10 bg-transparent px-2 py-1 text-xs outline-none placeholder:text-neutral-400 focus:border-[var(--onyx-accent)] dark:border-white/10"
      />

      <MonthGrid
        view={view}
        settings={settings}
        sizes={sizes}
        activePath={activeTab}
        onPick={openDailyNote}
      />
    </div>
  );
}
