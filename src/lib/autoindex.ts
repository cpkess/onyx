import { api } from "./api";

// Debounced, fire-and-forget incremental embedding of notes after they're saved.
// The backend no-ops unless a vector index already exists and an embed model is
// configured, so this stays cheap and never starts heavy work on its own.

const DELAY = 2500;
const timers = new Map<string, number>();

/** Queue a single note for (re)embedding once it's been idle for a moment. */
export function queueIndex(path: string) {
  const existing = timers.get(path);
  if (existing !== undefined) window.clearTimeout(existing);
  timers.set(
    path,
    window.setTimeout(() => {
      timers.delete(path);
      api.aiIndexNote(path).catch(() => {});
    }, DELAY)
  );
}
