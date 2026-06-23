// Dataview value model. Values are plain JS values plus a few wrappers:
//   number | string | boolean | null | Date | DvLink | DvValue[] | object

export class DvLink {
  constructor(
    readonly name: string,
    readonly path: string | null = null,
    readonly subpath: string | null = null,
    readonly display: string | null = null
  ) {}
  toString() {
    return this.display ?? this.name;
  }
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2})?)?$/;
const NUMERIC = /^-?\d+(?:\.\d+)?$/;
const WIKILINK = /^\[\[([^\]]+)\]\]$/;

/** Coerce a raw stored value into a typed Dataview value (dates, numbers, links). */
export function lift(v: unknown): unknown {
  if (v == null) return null;
  if (Array.isArray(v)) return v.map(lift);
  if (typeof v === "number" || typeof v === "boolean") return v;
  if (typeof v === "object") return v;
  if (typeof v === "string") {
    const s = v.trim();
    const wl = s.match(WIKILINK);
    if (wl) {
      const body = wl[1];
      const name = body.split("|")[0].split("#")[0].trim();
      const display = body.includes("|") ? body.split("|")[1].trim() : null;
      const subpath = body.includes("#") ? body.split("#")[1].split("|")[0].trim() : null;
      return new DvLink(name, null, subpath, display);
    }
    if (NUMERIC.test(s)) return Number(s);
    if (s === "true") return true;
    if (s === "false") return false;
    if (ISO_DATE.test(s)) {
      const d = new Date(s.replace(" ", "T"));
      if (!isNaN(d.getTime())) return d;
    }
    return v;
  }
  return v;
}

export function isDate(v: unknown): v is Date {
  return v instanceof Date && !isNaN(v.getTime());
}

export function truthy(v: unknown): boolean {
  if (v == null) return false;
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.length > 0;
  if (Array.isArray(v)) return v.length > 0;
  return true;
}

/** Three-way compare for SORT and ordering operators. */
export function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  if (isDate(a) && isDate(b)) return a.getTime() - b.getTime();
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "boolean" && typeof b === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  if (Array.isArray(a) && Array.isArray(b)) {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = compare(a[i], b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  }
  return String(toText(a)).localeCompare(String(toText(b)));
}

export function equals(a: unknown, b: unknown): boolean {
  if (isDate(a) && isDate(b)) return a.getTime() === b.getTime();
  if (a instanceof DvLink || b instanceof DvLink) {
    return linkName(a) === linkName(b);
  }
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => equals(x, b[i]));
  }
  return a === b;
}

function linkName(v: unknown): string | null {
  if (v instanceof DvLink) return v.name.toLowerCase();
  if (typeof v === "string") return v.replace(/^\[\[|\]\]$/g, "").toLowerCase();
  return null;
}

/** `contains(haystack, needle)` semantics, also used by the `contains` function. */
export function contains(haystack: unknown, needle: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((x) => equals(x, needle) || contains(x, needle));
  if (typeof haystack === "string") return haystack.toLowerCase().includes(String(toText(needle)).toLowerCase());
  if (haystack && typeof haystack === "object") return needle != null && String(needle) in haystack;
  return equals(haystack, needle);
}

const pad = (n: number) => String(n).padStart(2, "0");

/** Plain-text representation (used in comparisons and default rendering). */
export function toText(v: unknown): string {
  if (v == null) return "";
  if (v instanceof DvLink) return v.toString();
  if (isDate(v)) {
    const d = v;
    const base = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    return d.getHours() || d.getMinutes() ? `${base} ${pad(d.getHours())}:${pad(d.getMinutes())}` : base;
  }
  if (Array.isArray(v)) return v.map(toText).join(", ");
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}
