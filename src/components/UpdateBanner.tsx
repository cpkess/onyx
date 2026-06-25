import { useEffect, useState } from "react";
import type { Update } from "@tauri-apps/plugin-updater";
import { checkForUpdate, installUpdate } from "../lib/updater";

/** On launch, quietly checks GitHub for a newer Onyx and offers to install it. */
export function UpdateBanner() {
  const [update, setUpdate] = useState<Update | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    checkForUpdate().then((u) => {
      if (!cancelled && u) setUpdate(u);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!update || dismissed) return null;

  const run = async () => {
    setInstalling(true);
    try {
      await installUpdate(update, setProgress); // relaunches on success
    } catch (e) {
      console.error("update failed", e);
      setInstalling(false);
    }
  };

  return (
    <div className="fixed bottom-4 right-4 z-[80] w-72 rounded-lg border border-black/10 bg-white p-3 text-sm shadow-2xl ring-1 ring-black/5 dark:border-white/10 dark:bg-neutral-800 dark:ring-white/10">
      <div className="mb-1 font-medium text-neutral-800 dark:text-neutral-100">
        Onyx {update.version} available
      </div>
      {update.body && (
        <p className="mb-2 max-h-24 overflow-y-auto whitespace-pre-wrap text-xs text-neutral-500">
          {update.body}
        </p>
      )}
      {installing ? (
        <div className="text-xs text-neutral-500">
          {progress === null
            ? "Downloading…"
            : progress >= 1
              ? "Installing…"
              : `Downloading ${Math.round(progress * 100)}%`}
        </div>
      ) : (
        <div className="flex gap-2">
          <button
            onClick={run}
            className="rounded-md bg-[var(--onyx-accent)] px-3 py-1 text-xs font-medium text-white hover:opacity-90"
          >
            Install &amp; restart
          </button>
          <button
            onClick={() => setDismissed(true)}
            className="rounded-md px-3 py-1 text-xs text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            Later
          </button>
        </div>
      )}
    </div>
  );
}
