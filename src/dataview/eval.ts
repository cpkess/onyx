import type { Expr } from "./parser";
import { DvLink, compare, contains, equals, isDate, lift, toText, truthy } from "./value";

export type Rec = Record<string, unknown>;
export interface EvalCtx {
  row: Rec;
  thisRow: Rec | null;
  resolve: (name: string) => Rec | null;
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatDate(d: Date, fmt: string): string {
  return fmt
    .replace(/yyyy/g, String(d.getFullYear()))
    .replace(/MM/g, pad(d.getMonth() + 1))
    .replace(/dd/g, pad(d.getDate()))
    .replace(/HH/g, pad(d.getHours()))
    .replace(/mm/g, pad(d.getMinutes()))
    .replace(/ss/g, pad(d.getSeconds()));
}

function toDate(v: unknown): Date | null {
  if (isDate(v)) return v;
  if (typeof v === "string") {
    if (v === "today") return new Date();
    if (v === "now") return new Date();
    const d = new Date(v);
    return isNaN(d.getTime()) ? null : d;
  }
  return null;
}

const FUNCTIONS: Record<string, (a: unknown[]) => unknown> = {
  length: ([x]) => (Array.isArray(x) ? x.length : typeof x === "string" ? x.length : x == null ? 0 : 1),
  contains: ([h, n]) => contains(h, n),
  containsword: ([h, n]) => typeof h === "string" && typeof n === "string" && h.toLowerCase().split(/\W+/).includes(n.toLowerCase()),
  sum: ([x]) => (Array.isArray(x) ? x.reduce((s: number, v) => s + (Number(v) || 0), 0) : Number(x) || 0),
  avg: ([x]) => (Array.isArray(x) && x.length ? x.reduce((s: number, v) => s + (Number(v) || 0), 0) / x.length : 0),
  min: (a) => flat(a).reduce((m, v) => (m == null || compare(v, m) < 0 ? v : m), null as unknown),
  max: (a) => flat(a).reduce((m, v) => (m == null || compare(v, m) > 0 ? v : m), null as unknown),
  sort: ([x]) => (Array.isArray(x) ? [...x].sort(compare) : x),
  reverse: ([x]) => (Array.isArray(x) ? [...x].reverse() : x),
  first: ([x]) => (Array.isArray(x) ? (x.length ? x[0] : null) : x),
  last: ([x]) => (Array.isArray(x) ? (x.length ? x[x.length - 1] : null) : x),
  list: (a) => a,
  array: (a) => a,
  number: ([x]) => {
    const n = Number(typeof x === "string" ? x.replace(/[^0-9.\-]/g, "") : x);
    return isNaN(n) ? null : n;
  },
  string: ([x]) => toText(x),
  lower: ([x]) => toText(x).toLowerCase(),
  upper: ([x]) => toText(x).toUpperCase(),
  trim: ([x]) => toText(x).trim(),
  default: ([x, d]) => (x == null || x === "" ? d : x),
  nonnull: ([x]) => Array.isArray(x) ? x.filter((v) => v != null) : x,
  choice: ([c, a, b]) => (truthy(c) ? a : b),
  startswith: ([s, p]) => toText(s).startsWith(toText(p)),
  endswith: ([s, p]) => toText(s).endsWith(toText(p)),
  replace: ([s, a, b]) => toText(s).split(toText(a)).join(toText(b)),
  regexmatch: ([p, s]) => {
    try {
      return new RegExp(toText(p)).test(toText(s));
    } catch {
      return false;
    }
  },
  regexreplace: ([s, p, r]) => {
    try {
      return toText(s).replace(new RegExp(toText(p), "g"), toText(r));
    } catch {
      return toText(s);
    }
  },
  split: ([s, sep]) => toText(s).split(toText(sep)),
  join: ([x, sep]) => (Array.isArray(x) ? x.map(toText).join(sep == null ? ", " : toText(sep)) : toText(x)),
  round: ([x, p]) => {
    const f = Math.pow(10, typeof p === "number" ? p : 0);
    return Math.round((Number(x) || 0) * f) / f;
  },
  floor: ([x]) => Math.floor(Number(x) || 0),
  ceil: ([x]) => Math.ceil(Number(x) || 0),
  abs: ([x]) => Math.abs(Number(x) || 0),
  typeof: ([x]) => (x == null ? "null" : Array.isArray(x) ? "array" : isDate(x) ? "date" : x instanceof DvLink ? "link" : typeof x),
  date: ([x]) => toDate(x),
  now: () => new Date(),
  today: () => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  },
  dateformat: ([d, f]) => {
    const dt = toDate(d);
    return dt ? formatDate(dt, toText(f)) : "";
  },
  link: ([p, d]) => new DvLink(toText(p), null, null, d == null ? null : toText(d)),
  elink: ([url, d]) => new DvLink(toText(url), null, null, d == null ? toText(url) : toText(d)),
  striptime: ([d]) => {
    const dt = toDate(d);
    if (!dt) return null;
    const c = new Date(dt);
    c.setHours(0, 0, 0, 0);
    return c;
  },
};

function flat(args: unknown[]): unknown[] {
  return args.length === 1 && Array.isArray(args[0]) ? (args[0] as unknown[]) : args;
}

export function evaluate(e: Expr, ctx: EvalCtx): unknown {
  switch (e.t) {
    case "lit":
      return e.v;
    case "list":
      return e.items.map((i) => evaluate(i, ctx));
    case "link":
      return new DvLink(e.name, null, e.subpath, e.display);
    case "var":
      if (e.name === "this") return ctx.thisRow;
      return e.name in ctx.row ? lift(ctx.row[e.name]) : null;
    case "member":
      return member(evaluate(e.obj, ctx), e.name, ctx);
    case "index": {
      const obj = evaluate(e.obj, ctx);
      const idx = evaluate(e.idx, ctx);
      if (Array.isArray(obj) && typeof idx === "number") return obj[idx] ?? null;
      if (obj && typeof obj === "object") return (obj as Rec)[String(idx)] ?? null;
      return null;
    }
    case "call": {
      const fn = FUNCTIONS[e.name];
      if (!fn) return null;
      return fn(e.args.map((a) => evaluate(a, ctx)));
    }
    case "unary": {
      const v = evaluate(e.e, ctx);
      if (e.op === "not") return !truthy(v);
      if (e.op === "-") return -(Number(v) || 0);
      return v;
    }
    case "binary":
      return binary(e.op, e.l, e.r, ctx);
  }
}

function member(obj: unknown, name: string, ctx: EvalCtx): unknown {
  if (obj == null) return null;
  if (obj instanceof DvLink) {
    const page = ctx.resolve(obj.name);
    return page ? member(page, name, ctx) : null;
  }
  if (isDate(obj)) {
    switch (name) {
      case "year": return obj.getFullYear();
      case "month": return obj.getMonth() + 1;
      case "day": return obj.getDate();
      case "hour": return obj.getHours();
      case "minute": return obj.getMinutes();
      case "second": return obj.getSeconds();
      case "weekday": return obj.getDay();
      default: return null;
    }
  }
  if (Array.isArray(obj)) return obj.map((o) => member(o, name, ctx));
  if (typeof obj === "object") return lift((obj as Rec)[name] ?? null);
  return null;
}

function binary(op: string, le: Expr, re: Expr, ctx: EvalCtx): unknown {
  if (op === "and") return truthy(evaluate(le, ctx)) && truthy(evaluate(re, ctx));
  if (op === "or") return truthy(evaluate(le, ctx)) || truthy(evaluate(re, ctx));
  const l = evaluate(le, ctx);
  const r = evaluate(re, ctx);
  switch (op) {
    case "=": return equals(l, r);
    case "!=": return !equals(l, r);
    case "<": return compare(l, r) < 0;
    case "<=": return compare(l, r) <= 0;
    case ">": return compare(l, r) > 0;
    case ">=": return compare(l, r) >= 0;
    case "+":
      if (typeof l === "number" && typeof r === "number") return l + r;
      if (Array.isArray(l) && Array.isArray(r)) return [...l, ...r];
      if (isDate(l) && typeof r === "number") return new Date(l.getTime() + r * 86400000);
      return toText(l) + toText(r);
    case "-":
      if (isDate(l) && isDate(r)) return (l.getTime() - r.getTime()) / 86400000;
      return (Number(l) || 0) - (Number(r) || 0);
    case "*": return (Number(l) || 0) * (Number(r) || 0);
    case "/": return (Number(l) || 0) / (Number(r) || 0);
    case "%": return (Number(l) || 0) % (Number(r) || 0);
    default: return null;
  }
}
