import { noteName, type Page, type PageTask } from "../lib/api";
import { parseExpression, parseQuery, type Query, type Source } from "./parser";
import { evaluate, type Rec } from "./eval";
import { DvLink, compare, isDate, lift, toText, truthy } from "./value";

export type DvResult =
  | { kind: "table"; headers: string[]; rows: unknown[][]; groups?: { key: unknown; rows: unknown[][] }[] }
  | { kind: "list"; items: unknown[]; groups?: { key: unknown; items: unknown[] }[] }
  | { kind: "task"; tasks: PageTask[] }
  | { kind: "calendar"; byDate: Record<string, { label: string; path: string }[]> }
  | { kind: "error"; message: string };

function pageRecord(p: Page): Rec {
  const lifted: Rec = {};
  if (p.fields && typeof p.fields === "object") {
    for (const [k, v] of Object.entries(p.fields)) lifted[k] = lift(v);
  }
  const file = {
    name: p.name,
    folder: p.folder,
    path: p.path,
    ext: "md",
    link: new DvLink(p.name, p.path),
    size: p.size,
    ctime: new Date(p.ctime * 1000),
    mtime: new Date(p.mtime * 1000),
    tags: p.tags.map((t) => "#" + t),
    etags: p.tags.map((t) => "#" + t),
    tasks: p.tasks.map((t) => ({
      text: t.text,
      checked: t.checked,
      completed: t.checked,
      line: t.line,
      path: t.path,
    })),
    outlinks: p.outlinks.map((op) => new DvLink(noteName(op), op)),
    inlinks: p.inlinks.map((ip) => new DvLink(noteName(ip), ip)),
  };
  return { ...lifted, file, tags: file.tags, __page: p };
}

function pageOf(r: Rec): Page {
  return r.__page as Page;
}

function sourcePaths(src: Source, all: Rec[], thisPath: string | null, resolve: (n: string) => Rec | null): Set<string> {
  const allPaths = () => new Set(all.map((r) => pageOf(r).path));
  switch (src.s) {
    case "all":
      return allPaths();
    case "tag": {
      const want = ("#" + src.tag).toLowerCase();
      return new Set(
        all
          .filter((r) =>
            (pageOf(r).tags ?? []).some((t) => {
              const tg = ("#" + t).toLowerCase();
              return tg === want || tg.startsWith(want + "/");
            })
          )
          .map((r) => pageOf(r).path)
      );
    }
    case "folder": {
      const f = src.path.replace(/\/+$/, "");
      return new Set(
        all
          .filter((r) => {
            const p = pageOf(r);
            return (
              f === "" ||
              p.folder === f ||
              p.folder.startsWith(f + "/") ||
              p.path === f ||
              p.path === f + ".md"
            );
          })
          .map((r) => pageOf(r).path)
      );
    }
    case "incoming": {
      const tgt = resolve(src.link);
      if (!tgt) return new Set();
      const tp = pageOf(tgt).path;
      return new Set(all.filter((r) => pageOf(r).outlinks.includes(tp)).map((r) => pageOf(r).path));
    }
    case "outgoing": {
      const tgt = resolve(src.link);
      return new Set(tgt ? pageOf(tgt).outlinks : []);
    }
    case "this":
      return new Set(thisPath ? [thisPath] : []);
    case "and": {
      const a = sourcePaths(src.a, all, thisPath, resolve);
      const b = sourcePaths(src.b, all, thisPath, resolve);
      return new Set([...a].filter((x) => b.has(x)));
    }
    case "or": {
      const a = sourcePaths(src.a, all, thisPath, resolve);
      const b = sourcePaths(src.b, all, thisPath, resolve);
      return new Set([...a, ...b]);
    }
    case "not": {
      const a = sourcePaths(src.a, all, thisPath, resolve);
      return new Set([...allPaths()].filter((x) => !a.has(x)));
    }
  }
}

/** Run a DQL query against the page set. `currentPath` powers `this`/`[[]]`. */
export function runDql(text: string, pages: Page[], currentPath: string | null): DvResult {
  let q: Query;
  try {
    q = parseQuery(text);
  } catch (e) {
    return { kind: "error", message: `Parse error: ${e}` };
  }

  const records = pages.map(pageRecord);
  const byName = new Map<string, Rec>();
  const byPath = new Map<string, Rec>();
  for (const r of records) {
    byName.set(pageOf(r).name.toLowerCase(), r);
    byPath.set(pageOf(r).path, r);
  }
  const resolve = (n: string): Rec | null => {
    const key = n.split("#")[0].split("|")[0].trim().toLowerCase();
    return byName.get(key) ?? byPath.get(n) ?? null;
  };
  const thisRow = currentPath ? byPath.get(currentPath) ?? null : null;

  try {
    const fromPaths = q.from
      ? sourcePaths(q.from, records, currentPath, resolve)
      : new Set(records.map((r) => pageOf(r).path));
    let rows = records.filter((r) => fromPaths.has(pageOf(r).path));

    let groups: { key: unknown; rows: Rec[] }[] | null = null;

    for (const cmd of q.commands) {
      const ctx = (row: Rec) => ({ row, thisRow, resolve });
      if (cmd.k === "where") {
        if (groups) groups = groups.map((g) => ({ ...g, rows: g.rows.filter((r) => truthy(evaluate(cmd.e, ctx(r)))) }));
        else rows = rows.filter((r) => truthy(evaluate(cmd.e, ctx(r))));
      } else if (cmd.k === "flatten") {
        const out: Rec[] = [];
        for (const r of rows) {
          const v = evaluate(cmd.e, ctx(r));
          const items = Array.isArray(v) ? v : [v];
          for (const item of items.length ? items : [null]) out.push({ ...r, [cmd.as]: item });
        }
        rows = out;
      } else if (cmd.k === "sort") {
        const cmp = (a: Rec, b: Rec) => {
          for (const key of cmd.keys) {
            const c = compare(evaluate(key.expr, ctx(a)), evaluate(key.expr, ctx(b)));
            if (c) return key.dir === "desc" ? -c : c;
          }
          return 0;
        };
        if (groups) groups.sort((x, y) => (compare(x.key, y.key) * (cmd.keys[0]?.dir === "desc" ? -1 : 1)));
        else rows = [...rows].sort(cmp);
      } else if (cmd.k === "group") {
        const m = new Map<string, { key: unknown; rows: Rec[] }>();
        for (const r of rows) {
          const key = evaluate(cmd.e, ctx(r));
          const kk = toText(key);
          if (!m.has(kk)) m.set(kk, { key, rows: [] });
          m.get(kk)!.rows.push(r);
        }
        groups = [...m.values()];
      } else if (cmd.k === "limit") {
        if (groups) groups = groups.slice(0, cmd.n);
        else rows = rows.slice(0, cmd.n);
      }
    }

    const ev = (e: Parameters<typeof evaluate>[0], r: Rec) => evaluate(e, { row: r, thisRow, resolve });

    if (q.type === "TASK") {
      const tasks = (groups ? groups.flatMap((g) => g.rows) : rows).flatMap((r) => pageOf(r).tasks);
      return { kind: "task", tasks };
    }
    if (q.type === "CALENDAR") {
      const byDate: Record<string, { label: string; path: string }[]> = {};
      const all = groups ? groups.flatMap((g) => g.rows) : rows;
      for (const r of all) {
        const v = q.calendarExpr ? ev(q.calendarExpr, r) : null;
        if (isDate(v)) {
          const key = `${v.getFullYear()}-${String(v.getMonth() + 1).padStart(2, "0")}-${String(v.getDate()).padStart(2, "0")}`;
          (byDate[key] ||= []).push({ label: pageOf(r).name, path: pageOf(r).path });
        }
      }
      return { kind: "calendar", byDate };
    }
    if (q.type === "LIST") {
      const toItem = (r: Rec) => (q.listExpr ? ev(q.listExpr, r) : (r.file as Rec).link);
      if (groups) return { kind: "list", items: [], groups: groups.map((g) => ({ key: g.key, items: g.rows.map(toItem) })) };
      return { kind: "list", items: rows.map(toItem) };
    }
    // TABLE
    const headers = (q.withoutId ? [] : ["File"]).concat(q.columns.map((c) => c.header));
    const toRow = (r: Rec) =>
      (q.withoutId ? [] : [(r.file as Rec).link]).concat(q.columns.map((c) => ev(c.expr, r)));
    if (groups) return { kind: "table", headers, rows: [], groups: groups.map((g) => ({ key: g.key, rows: g.rows.map(toRow) })) };
    return { kind: "table", headers, rows: rows.map(toRow) };
  } catch (e) {
    return { kind: "error", message: `Query error: ${e}` };
  }
}

/** Evaluate a single inline expression against the current page (`this`). */
export function runInline(text: string, pages: Page[], currentPath: string | null): unknown {
  try {
    const records = pages.map(pageRecord);
    const byName = new Map<string, Rec>();
    const byPath = new Map<string, Rec>();
    for (const r of records) {
      byName.set(pageOf(r).name.toLowerCase(), r);
      byPath.set(pageOf(r).path, r);
    }
    const resolve = (n: string) =>
      byName.get(n.split("#")[0].split("|")[0].trim().toLowerCase()) ?? byPath.get(n) ?? null;
    const thisRow = currentPath ? byPath.get(currentPath) ?? null : null;
    return evaluate(parseExpression(text), { row: thisRow ?? {}, thisRow, resolve });
  } catch {
    return null;
  }
}

export { toText } from "./value";
