import { api, type Page } from "../lib/api";

// In-memory cache of vault pages for the Dataview engine. Widgets read the
// cache synchronously; the cache reloads on vault changes and bumps a version
// so dependent widgets recreate.
let cache: Page[] = [];
let version = 0;
let loaded = false;
let inflight: Promise<Page[]> | null = null;
const listeners = new Set<() => void>();

export function getCachedPages(): Page[] {
  return cache;
}
export function pagesVersion(): number {
  return version;
}

function reload(): Promise<Page[]> {
  return api
    .getPages()
    .then((p) => {
      cache = p;
      loaded = true;
      version++;
      inflight = null;
      listeners.forEach((l) => l());
      return p;
    })
    .catch(() => {
      inflight = null;
      return cache;
    });
}

/** Ensure pages are loaded at least once. */
export function ensurePages(): Promise<Page[]> {
  if (loaded) return Promise.resolve(cache);
  if (!inflight) inflight = reload();
  return inflight;
}

/** Force a reload (call after the vault changes). */
export function invalidatePages(): void {
  loaded = false;
  if (!inflight) inflight = reload();
}

export function onPagesChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
