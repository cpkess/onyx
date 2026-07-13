import { describe, it, expect } from "vitest";
import { buildDql, formatValue, type QuerySpec } from "./build";

const base: QuerySpec = {
  type: "TABLE",
  source: { kind: "all" },
  columns: [],
  filters: [],
  filterJoin: "and",
  sort: [],
};

describe("formatValue", () => {
  it("leaves numbers/bools/links/exprs bare, quotes strings", () => {
    expect(formatValue("42")).toBe("42");
    expect(formatValue("true")).toBe("true");
    expect(formatValue("[[Note]]")).toBe("[[Note]]");
    expect(formatValue("file.mtime")).toBe("file.mtime");
    expect(formatValue("done")).toBe('"done"');
    expect(formatValue('a"b')).toBe('"a\\"b"');
  });
});

describe("buildDql", () => {
  it("TABLE with columns, folder source, AND filters, sort, limit", () => {
    const spec: QuerySpec = {
      ...base,
      type: "TABLE",
      source: { kind: "folder", value: "Projects/" },
      columns: [
        { expr: "status" },
        { expr: "file.mtime", header: "Modified" },
      ],
      filters: [
        { field: "status", op: "=", value: "done" },
        { field: "tags", op: "contains", value: "urgent" },
      ],
      filterJoin: "and",
      sort: [{ field: "file.mtime", dir: "desc" }],
      limit: 10,
    };
    expect(buildDql(spec)).toBe(
      'TABLE status, file.mtime AS "Modified"\n' +
        'FROM "Projects"\n' +
        'WHERE status = "done" and contains(tags, "urgent")\n' +
        "SORT file.mtime DESC\n" +
        "LIMIT 10"
    );
  });

  it("tag source + OR join", () => {
    const spec: QuerySpec = {
      ...base,
      type: "LIST",
      source: { kind: "tag", value: "project" },
      filters: [
        { field: "status", op: "=", value: "active" },
        { field: "status", op: "=", value: "review" },
      ],
      filterJoin: "or",
    };
    expect(buildDql(spec)).toBe(
      "LIST\nFROM #project\nWHERE status = \"active\" or status = \"review\""
    );
  });

  it("TASK with a [[link]] source", () => {
    expect(
      buildDql({ ...base, type: "TASK", source: { kind: "links", value: "Project Aurora" } })
    ).toBe("TASK\nFROM [[Project Aurora]]");
  });

  it("bare TABLE, all source, no clauses", () => {
    expect(buildDql(base)).toBe("TABLE");
  });

  it("drops incomplete filter/column/sort rows", () => {
    const spec: QuerySpec = {
      ...base,
      columns: [{ expr: "status" }, { expr: "  " }],
      filters: [{ field: "", op: "=", value: "x" }],
      sort: [{ field: "", dir: "asc" }],
      limit: 0,
    };
    expect(buildDql(spec)).toBe("TABLE status");
  });

  it("CALENDAR defaults to file.ctime", () => {
    expect(buildDql({ ...base, type: "CALENDAR" })).toBe("CALENDAR file.ctime");
  });
});
