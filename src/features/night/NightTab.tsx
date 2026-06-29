import { useCallback, useEffect, useState } from "react";
import {
  api,
  type MorningReview,
  type NightSuggestion,
  type ProcessingStatus,
} from "../../lib/api";
import { useStore } from "../../state/store";

type Sub = "today" | "review" | "processing";

export function NightTab() {
  const [sub, setSub] = useState<Sub>("today");
  const subs: [Sub, string][] = [
    ["today", "Today"],
    ["review", "Review"],
    ["processing", "Processing"],
  ];
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 px-2 py-1.5">
        {subs.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`flex-1 rounded-md py-1 text-xs ${
              sub === t
                ? "bg-[var(--onyx-accent)] font-medium text-white"
                : "text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            }`}
          >
            {label}
          </button>
        ))}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {sub === "today" && <Today onReview={() => setSub("review")} />}
        {sub === "review" && <Review />}
        {sub === "processing" && <Processing />}
      </div>
    </div>
  );
}

function Today({ onReview }: { onReview: () => void }) {
  const [review, setReview] = useState<MorningReview | null>(null);

  useEffect(() => {
    api.getMorningReview().then(setReview).catch(() => setReview(null));
  }, []);

  if (!review || !review.has_run) {
    return (
      <Empty>
        No overnight run yet. Onyx will process your notes while idle &amp; charging — or run it now
        from the Processing tab.
      </Empty>
    );
  }

  return (
    <div className="px-3 py-3">
      <h3 className="mb-1 text-sm font-semibold text-neutral-800 dark:text-neutral-100">
        Good {greeting()}.
      </h3>
      <p className="mb-3 text-xs text-neutral-500">Last night Onyx:</p>
      <ul className="mb-4 space-y-1 text-sm text-neutral-700 dark:text-neutral-200">
        <li>✓ Processed {review.notes_processed} note(s)</li>
        <li>✓ Found {review.links_found} relationship(s)</li>
        <li>✓ Created {review.summaries_created} summary/-ies</li>
      </ul>
      <button
        onClick={onReview}
        className="w-full rounded-md bg-[var(--onyx-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
      >
        Review {review.pending_suggestions} suggestion(s)
      </button>
    </div>
  );
}

function Review() {
  const openNote = useStore((s) => s.openNote);
  const [items, setItems] = useState<NightSuggestion[] | null>(null);
  const [busy, setBusy] = useState<number | null>(null);

  const load = useCallback(() => {
    api.getSuggestions().then(setItems).catch(() => setItems([]));
  }, []);
  useEffect(() => load(), [load]);

  const remove = (id: number) => setItems((prev) => prev?.filter((s) => s.id !== id) ?? null);

  const accept = async (s: NightSuggestion) => {
    setBusy(s.id);
    try {
      const path = await api.acceptSuggestion(s.id);
      remove(s.id);
      if (path) openNote(path);
    } catch (e) {
      console.error("accept failed", e);
    } finally {
      setBusy(null);
    }
  };
  const dismiss = async (s: NightSuggestion, never: boolean) => {
    setBusy(s.id);
    try {
      await api.dismissSuggestion(s.id, never);
      remove(s.id);
    } finally {
      setBusy(null);
    }
  };

  if (!items) return <Empty>Loading…</Empty>;
  if (items.length === 0) return <Empty>No suggestions to review.</Empty>;

  return (
    <div className="px-2 py-2">
      {items.map((s) => (
        <div key={s.id} className="mb-2 rounded-md border border-black/10 p-2 dark:border-white/10">
          <div className="mb-1 flex items-center justify-between gap-2">
            <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-white/10">
              {s.kind}
            </span>
            <span className="text-[10px] text-neutral-400">
              {Math.round(s.confidence * 100)}%
            </span>
          </div>
          <div className="truncate text-sm font-medium text-neutral-800 dark:text-neutral-100">
            {s.title}
          </div>
          {s.preview && (
            <p className="mt-0.5 line-clamp-3 whitespace-pre-wrap text-xs text-neutral-500">
              {s.preview}
            </p>
          )}
          <div className="mt-2 flex gap-1.5">
            <button
              onClick={() => accept(s)}
              disabled={busy === s.id}
              className="rounded bg-[var(--onyx-accent)] px-2 py-0.5 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              Apply
            </button>
            <button
              onClick={() => dismiss(s, false)}
              disabled={busy === s.id}
              className="rounded bg-black/5 px-2 py-0.5 text-xs text-neutral-600 hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:text-neutral-300"
            >
              Dismiss
            </button>
            <button
              onClick={() => dismiss(s, true)}
              disabled={busy === s.id}
              className="rounded px-2 py-0.5 text-xs text-neutral-400 hover:text-red-500 disabled:opacity-40"
            >
              Never
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

function Processing() {
  const [status, setStatus] = useState<ProcessingStatus | null>(null);

  const refresh = useCallback(() => {
    api.getProcessingStatus().then(setStatus).catch(() => setStatus(null));
  }, []);
  useEffect(() => {
    refresh();
    const id = window.setInterval(refresh, 3000);
    return () => window.clearInterval(id);
  }, [refresh]);

  const run = async () => {
    await api.startProcessing().catch(() => {});
    refresh();
  };
  const pause = async () => {
    await api.pauseProcessing().catch(() => {});
    refresh();
  };

  return (
    <div className="px-3 py-3 text-sm">
      <Row label="Status" value={status?.running ? "Running…" : "Idle"} />
      <Row label="Mode" value={status?.mode ?? "—"} />
      <Row label="Queued jobs" value={String(status?.pending_jobs ?? 0)} />
      <Row label="Pending suggestions" value={String(status?.pending_suggestions ?? 0)} />
      <div className="mt-3 flex gap-2">
        {status?.running ? (
          <button
            onClick={pause}
            className="rounded-md bg-black/5 px-3 py-1.5 text-xs text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200"
          >
            Pause
          </button>
        ) : (
          <button
            onClick={run}
            className="rounded-md bg-[var(--onyx-accent)] px-3 py-1.5 text-xs font-medium text-white hover:opacity-90"
          >
            Run overnight processing now
          </button>
        )}
      </div>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between border-b border-black/5 py-1.5 dark:border-white/5">
      <span className="text-neutral-500">{label}</span>
      <span className="text-neutral-800 dark:text-neutral-200">{value}</span>
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-xs text-neutral-400">{children}</p>;
}

function greeting(): string {
  const h = new Date().getHours();
  if (h < 12) return "morning";
  if (h < 18) return "afternoon";
  return "evening";
}
