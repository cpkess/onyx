/** Host callbacks the widgets use for async resolution (set by the Editor). */
export interface Host {
  /** Resolve an asset/image reference to an absolute path (for convertFileSrc). */
  resolveAsset: (target: string) => Promise<string | null>;
  /** Read a note's raw markdown by vault path. */
  readNote: (path: string) => Promise<string | null>;
  /** Resolve a wikilink name to a vault path. */
  resolvePath: (name: string) => Promise<string | null>;
}

let host: Host = {
  resolveAsset: async () => null,
  readNote: async () => null,
  resolvePath: async () => null,
};

export function setHost(h: Partial<Host>) {
  host = { ...host, ...h };
}
export function getHost(): Host {
  return host;
}

/** A pending "scroll to heading/block after opening" request. */
let pendingScroll: { path: string; anchor: string } | null = null;
export function setPendingScroll(p: { path: string; anchor: string } | null) {
  pendingScroll = p;
}
export function getPendingScroll() {
  return pendingScroll;
}
