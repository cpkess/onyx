import { api, type Atom, type BlockLoc, type BlockRef } from "../lib/api";

// Per-page cache of block-level linked references (every block across the vault
// that references a page). Mirrors pages.ts: widgets read synchronously, the
// cache reloads lazily per page and bumps a version so dependent widgets
// recreate. Cleared wholesale when the vault reindexes.

const cache = new Map<string, BlockRef[]>();
const inflight = new Map<string, Promise<BlockRef[]>>();
let version = 0;
const listeners = new Set<() => void>();

export function blockRefsVersion(): number {
  return version;
}

/** Cached refs for a page name, or `undefined` if not fetched yet. */
export function getCachedBlockRefs(name: string): BlockRef[] | undefined {
  return cache.get(name.toLowerCase());
}

/** Ensure the linked references for `name` are loaded (fetches once). */
export function ensureBlockRefs(name: string): Promise<BlockRef[]> {
  const key = name.toLowerCase();
  const have = cache.get(key);
  if (have) return Promise.resolve(have);
  let p = inflight.get(key);
  if (!p) {
    p = api
      .getBlockBacklinks(name)
      .then((refs) => {
        cache.set(key, refs);
        inflight.delete(key);
        version++;
        listeners.forEach((l) => l());
        return refs;
      })
      .catch(() => {
        inflight.delete(key);
        return [];
      });
    inflight.set(key, p);
  }
  return p;
}

// ---- `((block-ref))` resolution cache ----

const locCache = new Map<string, BlockLoc | null>();
const locInflight = new Map<string, Promise<BlockLoc | null>>();

/** Cached location for a `^id` (null = unresolved, undefined = not fetched). */
export function getCachedBlockLoc(id: string): BlockLoc | null | undefined {
  return locCache.get(id.replace(/^\^/, ""));
}

/** Resolve a `^id` to its block location (fetches once). */
export function ensureBlockLoc(id: string): Promise<BlockLoc | null> {
  const key = id.replace(/^\^/, "");
  if (locCache.has(key)) return Promise.resolve(locCache.get(key)!);
  let p = locInflight.get(key);
  if (!p) {
    p = api
      .resolveBlockRef(key)
      .then((loc) => {
        locCache.set(key, loc);
        locInflight.delete(key);
        version++;
        listeners.forEach((l) => l());
        return loc;
      })
      .catch(() => {
        locInflight.delete(key);
        return null;
      });
    locInflight.set(key, p);
  }
  return p;
}

// ---- Atom-backed primitives cache (per page) ----

const atomCache = new Map<string, Atom[]>();
const atomInflight = new Map<string, Promise<Atom[]>>();

/** Cached approved atoms relevant to a page, or `undefined` if not fetched. */
export function getCachedAtoms(name: string): Atom[] | undefined {
  return atomCache.get(name.toLowerCase());
}

/** Ensure the atoms for a page are loaded (fetches once). */
export function ensureAtoms(name: string): Promise<Atom[]> {
  const key = name.toLowerCase();
  const have = atomCache.get(key);
  if (have) return Promise.resolve(have);
  let p = atomInflight.get(key);
  if (!p) {
    p = api
      .atomsForPage(name)
      .then((atoms) => {
        atomCache.set(key, atoms);
        atomInflight.delete(key);
        version++;
        listeners.forEach((l) => l());
        return atoms;
      })
      .catch(() => {
        atomInflight.delete(key);
        return [];
      });
    atomInflight.set(key, p);
  }
  return p;
}

/**
 * Refresh caches after the vault reindexes. Rather than clearing (which would
 * blank out an open page's primitives until the note is reopened), we re-fetch
 * every page that was already loaded and update it in place. Block-ref
 * transclusions re-resolve lazily, so those caches are dropped.
 */
export function invalidateBlockRefs(): void {
  locCache.clear();
  locInflight.clear();
  inflight.clear();
  atomInflight.clear();

  // Re-fetch already-loaded pages in place. getBlockBacklinks / atomsForPage
  // match case-insensitively, so the lowercased cache key works as the arg.
  for (const key of [...cache.keys()]) {
    api
      .getBlockBacklinks(key)
      .then((refs) => {
        cache.set(key, refs);
        version++;
        listeners.forEach((l) => l());
      })
      .catch(() => {});
  }
  for (const key of [...atomCache.keys()]) {
    api
      .atomsForPage(key)
      .then((atoms) => {
        atomCache.set(key, atoms);
        version++;
        listeners.forEach((l) => l());
      })
      .catch(() => {});
  }
  // Bump once now so `((block-ref))` widgets re-resolve on the next render.
  version++;
  listeners.forEach((l) => l());
}

export function onBlockRefsChanged(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}
