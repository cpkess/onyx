import type { BadgeRule } from "./badges";

export type DvType = "TABLE" | "LIST" | "TASK" | "CALENDAR";
export type SourceKind = "all" | "folder" | "tag" | "links";

export interface DvFilter {
  field: string;
  op: string; // "=", "!=", "<", ">", "<=", ">=", "contains"
  value: string;
}
export interface DvSort {
  field: string;
  dir: "asc" | "desc";
}
export interface DvColumn {
  expr: string;
  header?: string;
  badges?: BadgeRule[]; // per-table conditional formatting (ignored by buildDql)
}

export interface QuerySpec {
  type: DvType;
  source: { kind: SourceKind; value?: string };
  columns: DvColumn[]; // TABLE only
  listExpr?: string; // LIST only
  calendarExpr?: string; // CALENDAR only
  filters: DvFilter[];
  filterJoin: "and" | "or";
  sort: DvSort[];
  limit?: number;
}

/** Format a raw value for DQL: numbers/booleans/links/expressions bare, else quoted. */
export function formatValue(v: string): string {
  const t = v.trim();
  if (t === "") return '""';
  if (/^-?\d+(\.\d+)?$/.test(t)) return t;
  if (t === "true" || t === "false" || t === "null") return t;
  if (/^\[\[.*\]\]$/.test(t)) return t;
  if (/^(file\.|date\(|now\b|today\b)/.test(t)) return t; // field/expression reference
  return `"${t.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function sourceClause(s: QuerySpec["source"]): string | null {
  const v = (s.value ?? "").trim();
  switch (s.kind) {
    case "folder":
      return v ? `FROM "${v.replace(/\/+$/, "")}"` : null;
    case "tag":
      return v ? `FROM #${v.replace(/^#/, "")}` : null;
    case "links":
      return v ? `FROM [[${v.replace(/^\[\[|\]\]$/g, "")}]]` : null;
    case "all":
    default:
      return null;
  }
}

function whereClause(spec: QuerySpec): string | null {
  const parts = spec.filters
    .filter((f) => f.field.trim())
    .map((f) => {
      if (f.op === "contains") return `contains(${f.field.trim()}, ${formatValue(f.value)})`;
      return `${f.field.trim()} ${f.op} ${formatValue(f.value)}`;
    });
  if (parts.length === 0) return null;
  return `WHERE ${parts.join(` ${spec.filterJoin} `)}`;
}

/** Generate a parseable Dataview (DQL) query string from a visual spec. */
export function buildDql(spec: QuerySpec): string {
  const lines: string[] = [];

  // Head
  if (spec.type === "TABLE") {
    const cols = spec.columns
      .filter((c) => c.expr.trim())
      .map((c) => (c.header?.trim() ? `${c.expr.trim()} AS "${c.header.trim()}"` : c.expr.trim()));
    lines.push(cols.length ? `TABLE ${cols.join(", ")}` : "TABLE");
  } else if (spec.type === "LIST") {
    lines.push(spec.listExpr?.trim() ? `LIST ${spec.listExpr.trim()}` : "LIST");
  } else if (spec.type === "CALENDAR") {
    lines.push(`CALENDAR ${spec.calendarExpr?.trim() || "file.ctime"}`);
  } else {
    lines.push("TASK");
  }

  const from = sourceClause(spec.source);
  if (from) lines.push(from);
  const where = whereClause(spec);
  if (where) lines.push(where);

  const sort = spec.sort
    .filter((s) => s.field.trim())
    .map((s) => `${s.field.trim()} ${s.dir.toUpperCase()}`);
  if (sort.length) lines.push(`SORT ${sort.join(", ")}`);

  if (spec.limit != null && spec.limit > 0) lines.push(`LIMIT ${Math.floor(spec.limit)}`);

  return lines.join("\n");
}
