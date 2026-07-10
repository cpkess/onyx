import { renderInline } from "../editor/render/markdown";
import { getCachedBlockRefs, getCachedAtoms } from "../dataview/blockrefs";
import type { BlockRef } from "../lib/api";

/**
 * A "primitive" is a typed page-body widget that smartly organizes a page's
 * linked references (every block across the vault that references this page).
 * Each primitive is a preconfigured query + renderer over the same block-refs
 * cache the Linked References section uses — not a new data path.
 */

export interface PrimitiveCtx {
  /** The page whose references we aggregate (the note the primitive lives on). */
  pageName: string;
  /** The note's path, so the page's own blocks can be excluded. */
  currentPath: string | null;
}

export interface Primitive {
  title: string;
  render(params: Record<string, string>, ctx: PrimitiveCtx): string;
}

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}

/** The page's linked-reference blocks, excluding the page's own note. */
function pageRefs(ctx: PrimitiveCtx): BlockRef[] {
  const all = getCachedBlockRefs(ctx.pageName) ?? [];
  if (!ctx.currentPath) return all;
  return all.filter((r) => r.source_path !== ctx.currentPath);
}

function taskItem(r: BlockRef): string {
  return (
    `<li><label><input type="checkbox" ${r.checked ? "checked" : ""} ` +
    `data-task-path="${escAttr(r.source_path)}" data-task-line="${r.line_start}"> ` +
    `${renderInline(r.text)}</label>` +
    `<span class="onyx-prim-src" data-wikilink="${escAttr(r.source_title)}">${escHtml(
      r.source_title
    )}</span></li>`
  );
}

function bulletItem(r: BlockRef): string {
  const anchor = r.block_id ? ` data-anchor="^${escAttr(r.block_id)}"` : "";
  return (
    `<li data-wikilink="${escAttr(r.source_title)}"${anchor}>` +
    `${renderInline(r.text)}` +
    `<span class="onyx-prim-src">${escHtml(r.source_title)}</span></li>`
  );
}

function empty(msg: string): string {
  return `<div class="onyx-dv-empty">${escHtml(msg)}</div>`;
}

/** A live checklist of every task block that mentions this page. */
const todo: Primitive = {
  title: "To-do",
  render(_params, ctx) {
    const tasks = pageRefs(ctx).filter((r) => r.kind === "task");
    if (tasks.length === 0) return empty("No linked to-dos.");
    const open = tasks.filter((t) => !t.checked);
    const done = tasks.filter((t) => t.checked);
    const ordered = [...open, ...done];
    return `<ul class="onyx-dv-tasks onyx-prim-tasks">${ordered.map(taskItem).join("")}</ul>`;
  },
};

/** All non-task linked blocks (a filtered mirror of Linked References). */
const notes: Primitive = {
  title: "Notes",
  render(_params, ctx) {
    const items = pageRefs(ctx).filter((r) => r.kind === "bullet" || r.kind === "para");
    if (items.length === 0) return empty("No linked notes.");
    return `<ul class="onyx-prim-list">${items.map(bulletItem).join("")}</ul>`;
  },
};

/** Source notes that mention this page, with mention counts. */
const mentions: Primitive = {
  title: "Mentions",
  render(_params, ctx) {
    const refs = pageRefs(ctx);
    if (refs.length === 0) return empty("No mentions.");
    const counts = new Map<string, { title: string; n: number }>();
    for (const r of refs) {
      const e = counts.get(r.source_path) ?? { title: r.source_title, n: 0 };
      e.n++;
      counts.set(r.source_path, e);
    }
    const rows = [...counts.values()]
      .sort((a, b) => b.n - a.n)
      .map(
        (e) =>
          `<li><span class="onyx-prim-src" data-wikilink="${escAttr(e.title)}">${escHtml(
            e.title
          )}</span> <span class="onyx-lr-count">${e.n}</span></li>`
      )
      .join("");
    return `<ul class="onyx-prim-list">${rows}</ul>`;
  },
};

function atomRow(text: string, src: string): string {
  return (
    `<li>${renderInline(text)}` +
    `<span class="onyx-prim-src" data-wikilink="${escAttr(src)}">${escHtml(src)}</span></li>`
  );
}

const normText = (s: string) => s.toLowerCase().replace(/\s+/g, " ").trim();

/**
 * A primitive backed by approved Atoms of a given kind, unioned with journal
 * blocks whose text reads like that kind (a `Decision:` / `Problem:` prefix).
 * This means it works immediately from the journals and grows richer once
 * Atoms synthesis has run. Duplicates (same text) are collapsed, atoms first.
 */
function atomPrimitive(
  kind: string,
  title: string,
  emptyMsg: string,
  blockRe: RegExp
): Primitive {
  return {
    title,
    render(_params, ctx) {
      const atoms = (getCachedAtoms(ctx.pageName) ?? []).filter((a) => a.kind === kind);
      const blocks = pageRefs(ctx).filter((r) => blockRe.test(r.text));
      const seen = new Set<string>();
      const rows: string[] = [];
      for (const a of atoms) {
        seen.add(normText(a.text));
        rows.push(atomRow(a.text, srcName(a.source_path)));
      }
      for (const b of blocks) {
        if (seen.has(normText(b.text))) continue;
        seen.add(normText(b.text));
        rows.push(atomRow(b.text, b.source_title));
      }
      if (rows.length === 0) return empty(emptyMsg);
      return `<ul class="onyx-prim-list">${rows.join("")}</ul>`;
    },
  };
}

/** File stem of a vault path (for the source-note chip). */
function srcName(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

const decisions = atomPrimitive(
  "decision",
  "Decisions",
  "No decisions yet.",
  /^\s*(decision|decided)\b/i
);
const painPoints = atomPrimitive(
  "pain_point",
  "Pain points",
  "No pain points yet.",
  /^\s*(problem|pain|blocker|blocked|risk|issue)\b/i
);
const insights = atomPrimitive(
  "insight",
  "Insights",
  "No insights yet.",
  /^\s*(insight|idea|learning|takeaway|realized)\b/i
);

export const primitives: Record<string, Primitive> = {
  todo,
  notes,
  mentions,
  decisions,
  "pain-points": painPoints,
  insights,
};

/** Parse an `onyx-primitive` fence body (`type` + simple `key: value` lines). */
export function parsePrimitive(body: string): { type: string; params: Record<string, string> } {
  const params: Record<string, string> = {};
  let type = "";
  for (const line of body.split("\n")) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const val = m[2].trim();
    if (key === "type") type = val.toLowerCase();
    else params[key] = val;
  }
  return { type, params };
}
