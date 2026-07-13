import { useEffect, useMemo, useState } from "react";
import { useStore } from "../state/store";
import { api, noteName, type TreeNode } from "../lib/api";
import { getCachedPages, ensurePages, onPagesChanged } from "../dataview/pages";
import { runDql } from "../dataview/engine";
import { renderDvResult } from "../editor/render/widgets";
import { buildDql, type DvType, type QuerySpec, type SourceKind } from "../dataview/build";
import { insertText } from "../editor/activeEditor";

const TYPES: DvType[] = ["TABLE", "LIST", "TASK", "CALENDAR"];
const OPS = ["=", "!=", "<", ">", "<=", ">=", "contains"];
const FILE_FIELDS = [
  "file.name", "file.folder", "file.path", "file.link", "file.size",
  "file.ctime", "file.mtime", "file.tags", "file.tasks", "file.inlinks", "file.outlinks",
];

function collectDirs(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.is_dir) {
      out.push(n.path);
      collectDirs(n.children, out);
    }
  }
  return out;
}

const field =
  "rounded border border-black/10 bg-transparent px-2 py-1 text-sm outline-none focus:border-[var(--onyx-accent)] dark:border-white/15";
const label = "mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500";

/** Visual builder that generates a `dataview` block, previews it, and inserts it. */
export function DataviewBuilder() {
  const open = useStore((s) => s.dataviewBuilderOpen);
  const setOpen = useStore((s) => s.setDataviewBuilderOpen);
  const tree = useStore((s) => s.tree);
  const activeTab = useStore((s) => s.activeTab);

  const [type, setType] = useState<DvType>("TABLE");
  const [sourceKind, setSourceKind] = useState<SourceKind>("all");
  const [sourceValue, setSourceValue] = useState("");
  const [filters, setFilters] = useState<QuerySpec["filters"]>([]);
  const [filterJoin, setFilterJoin] = useState<"and" | "or">("and");
  const [sortField, setSortField] = useState("");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [limit, setLimit] = useState("");
  const [columns, setColumns] = useState<QuerySpec["columns"]>([]);
  const [pv, setPv] = useState(0);
  const [tags, setTags] = useState<string[]>([]);
  const [notes, setNotes] = useState<string[]>([]);

  useEffect(() => {
    if (!open) return;
    ensurePages();
    api.getTags().then((t) => setTags(t.map(([n]) => n))).catch(() => {});
    api.getNoteNames().then(setNotes).catch(() => {});
    return onPagesChanged(() => setPv((v) => v + 1));
  }, [open]);

  const folders = useMemo(() => collectDirs(tree), [tree]);
  const fieldKeys = useMemo(() => {
    const set = new Set<string>(FILE_FIELDS);
    for (const p of getCachedPages()) {
      for (const k of Object.keys((p.fields as Record<string, unknown>) ?? {})) set.add(k);
    }
    return [...set].sort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pv, open]);

  const spec: QuerySpec = {
    type,
    source: { kind: sourceKind, value: sourceValue },
    columns,
    filters,
    filterJoin,
    sort: sortField ? [{ field: sortField, dir: sortDir }] : [],
    limit: limit ? Number(limit) : undefined,
  };
  const dql = buildDql(spec);
  const previewHtml = useMemo(() => {
    try {
      return renderDvResult(runDql(dql, getCachedPages(), activeTab));
    } catch (e) {
      return `<div class="onyx-dv-error">${String(e)}</div>`;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dql, pv]);

  if (!open) return null;

  const addFilter = () => setFilters((f) => [...f, { field: "", op: "=", value: "" }]);
  const setFilter = (i: number, patch: Partial<QuerySpec["filters"][number]>) =>
    setFilters((f) => f.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const rmFilter = (i: number) => setFilters((f) => f.filter((_, j) => j !== i));
  const addCol = () => setColumns((c) => [...c, { expr: "", header: "" }]);
  const setCol = (i: number, patch: Partial<QuerySpec["columns"][number]>) =>
    setColumns((c) => c.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const rmCol = (i: number) => setColumns((c) => c.filter((_, j) => j !== i));

  const insert = () => {
    insertText("\n```dataview\n" + dql + "\n```\n");
    setOpen(false);
  };

  const fieldOptions = (
    <>
      <option value=""></option>
      {fieldKeys.map((k) => (
        <option key={k} value={k}>{k}</option>
      ))}
    </>
  );

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="max-h-[84vh] w-[44rem] max-w-[94vw] overflow-y-auto rounded-xl bg-white p-4 shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 className="mb-3 text-lg font-semibold text-neutral-900 dark:text-white">
          Insert Dataview query
        </h2>

        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Show</label>
            <select className={`${field} w-full`} value={type} onChange={(e) => setType(e.target.value as DvType)}>
              {TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
          </div>
          <div>
            <label className={label}>From</label>
            <div className="flex gap-1">
              <select
                className={field}
                value={sourceKind}
                onChange={(e) => {
                  setSourceKind(e.target.value as SourceKind);
                  setSourceValue("");
                }}
              >
                <option value="all">Whole vault</option>
                <option value="folder">Folder</option>
                <option value="tag">Tag</option>
                <option value="links">Links to note</option>
              </select>
              {sourceKind === "folder" && (
                <select className={`${field} min-w-0 flex-1`} value={sourceValue} onChange={(e) => setSourceValue(e.target.value)}>
                  <option value=""></option>
                  {folders.map((f) => <option key={f} value={f}>{f}</option>)}
                </select>
              )}
              {sourceKind === "tag" && (
                <select className={`${field} min-w-0 flex-1`} value={sourceValue} onChange={(e) => setSourceValue(e.target.value)}>
                  <option value=""></option>
                  {tags.map((t) => <option key={t} value={t}>#{t}</option>)}
                </select>
              )}
              {sourceKind === "links" && (
                <select className={`${field} min-w-0 flex-1`} value={sourceValue} onChange={(e) => setSourceValue(e.target.value)}>
                  <option value=""></option>
                  {notes.map((n) => <option key={n} value={n}>{noteName(n)}</option>)}
                </select>
              )}
            </div>
          </div>
        </div>

        {type === "TABLE" && (
          <div className="mt-3">
            <label className={label}>Columns</label>
            {columns.map((c, i) => (
              <div key={i} className="mb-1 flex items-center gap-1">
                <select className={`${field} w-40`} value={c.expr} onChange={(e) => setCol(i, { expr: e.target.value })}>
                  {fieldOptions}
                </select>
                <input className={`${field} min-w-0 flex-1`} placeholder="header (optional)" value={c.header ?? ""} onChange={(e) => setCol(i, { header: e.target.value })} />
                <button className="px-1 text-neutral-400 hover:text-neutral-700" onClick={() => rmCol(i)}>✕</button>
              </div>
            ))}
            <button className="mt-1 text-xs text-neutral-500 hover:text-[var(--onyx-accent)]" onClick={addCol}>＋ Add column</button>
          </div>
        )}

        <div className="mt-3">
          <div className="flex items-center justify-between">
            <label className={label}>Where</label>
            {filters.length > 1 && (
              <select className={`${field} text-xs`} value={filterJoin} onChange={(e) => setFilterJoin(e.target.value as "and" | "or")}>
                <option value="and">match ALL (and)</option>
                <option value="or">match ANY (or)</option>
              </select>
            )}
          </div>
          {filters.map((f, i) => (
            <div key={i} className="mb-1 flex items-center gap-1">
              <select className={`${field} w-40`} value={f.field} onChange={(e) => setFilter(i, { field: e.target.value })}>
                {fieldOptions}
              </select>
              <select className={field} value={f.op} onChange={(e) => setFilter(i, { op: e.target.value })}>
                {OPS.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
              <input className={`${field} min-w-0 flex-1`} placeholder="value" value={f.value} onChange={(e) => setFilter(i, { value: e.target.value })} />
              <button className="px-1 text-neutral-400 hover:text-neutral-700" onClick={() => rmFilter(i)}>✕</button>
            </div>
          ))}
          <button className="mt-1 text-xs text-neutral-500 hover:text-[var(--onyx-accent)]" onClick={addFilter}>＋ Add filter</button>
        </div>

        <div className="mt-3 grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Sort by</label>
            <div className="flex gap-1">
              <select className={`${field} min-w-0 flex-1`} value={sortField} onChange={(e) => setSortField(e.target.value)}>
                {fieldOptions}
              </select>
              <select className={field} value={sortDir} onChange={(e) => setSortDir(e.target.value as "asc" | "desc")}>
                <option value="asc">Asc</option>
                <option value="desc">Desc</option>
              </select>
            </div>
          </div>
          <div>
            <label className={label}>Limit</label>
            <input className={`${field} w-full`} type="number" min={0} placeholder="none" value={limit} onChange={(e) => setLimit(e.target.value)} />
          </div>
        </div>

        <div className="mt-4">
          <label className={label}>Query</label>
          <pre className="overflow-x-auto rounded-md bg-black/5 px-3 py-2 text-xs dark:bg-white/10">{dql}</pre>
        </div>
        <div className="mt-2">
          <label className={label}>Preview</label>
          <div
            className="onyx-rendered max-h-48 overflow-auto rounded-md border border-black/10 px-3 py-2 text-sm dark:border-white/10"
            dangerouslySetInnerHTML={{ __html: previewHtml }}
          />
        </div>

        <div className="mt-4 flex justify-end gap-2">
          <button
            onClick={() => setOpen(false)}
            className="rounded-md px-3 py-1.5 text-sm text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/10"
          >
            Cancel
          </button>
          <button
            onClick={insert}
            className="rounded-md bg-[var(--onyx-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90"
          >
            Insert
          </button>
        </div>
      </div>
    </div>
  );
}
