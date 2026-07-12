import type { Page, TreeNode } from "./api";

/** The `[[Parent]]` name from a page's `parent` field (name part only), if any. */
export function parentName(page: Page): string | null {
  const p = (page.fields as Record<string, unknown> | undefined)?.parent;
  const raw = Array.isArray(p) ? p.map(String).find(Boolean) : p != null ? String(p) : "";
  const m = raw ? /\[\[([^\]]+)\]\]/.exec(raw) : null;
  return m ? m[1].split("|")[0].split("#")[0].trim() : null;
}

export interface Hierarchy {
  /** parent note path → its child notes (as file TreeNodes), sorted by name. */
  childrenOf: Map<string, TreeNode[]>;
  /** paths shown under a parent (so they're hidden from their physical spot). */
  relocated: Set<string>;
}

/**
 * Build the virtual parent/child hierarchy from the `parent` field of pages, so
 * sub-notes nest under their parent note like a folder. A note whose `parent`
 * resolves to an existing note is "relocated" — shown under that parent and
 * hidden from its physical folder position (avoids duplicates).
 */
export function buildHierarchy(pages: Page[]): Hierarchy {
  const nameToPath = new Map<string, string>();
  for (const p of pages) nameToPath.set(p.name.toLowerCase(), p.path);
  const childrenOf = new Map<string, TreeNode[]>();
  const relocated = new Set<string>();
  for (const p of pages) {
    const pn = parentName(p);
    if (!pn) continue;
    const parentPath = nameToPath.get(pn.toLowerCase());
    if (!parentPath || parentPath === p.path) continue;
    const node: TreeNode = {
      name: p.path.split("/").pop() ?? p.name,
      path: p.path,
      is_dir: false,
      children: [],
    };
    let arr = childrenOf.get(parentPath);
    if (!arr) {
      arr = [];
      childrenOf.set(parentPath, arr);
    }
    arr.push(node);
    relocated.add(p.path);
  }
  for (const arr of childrenOf.values()) arr.sort((a, b) => a.name.localeCompare(b.name));
  return { childrenOf, relocated };
}
