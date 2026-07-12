import { describe, it, expect } from "vitest";
import { buildHierarchy, parentName } from "./hierarchy";
import type { Page } from "./api";

function page(over: Partial<Page>): Page {
  return {
    path: "x.md",
    name: "x",
    folder: "",
    tags: [],
    mtime: 0,
    ctime: 0,
    size: 0,
    fields: {},
    tasks: [],
    outlinks: [],
    inlinks: [],
    ...over,
  };
}

describe("parentName", () => {
  it("extracts the name part of a parent wikilink", () => {
    expect(parentName(page({ fields: { parent: "[[Project Aurora]]" } }))).toBe("Project Aurora");
    expect(parentName(page({ fields: { parent: "[[Project Aurora|the X]]" } }))).toBe("Project Aurora");
    expect(parentName(page({ fields: { parent: ["[[A]]"] } }))).toBe("A");
    expect(parentName(page({ fields: {} }))).toBeNull();
    expect(parentName(page({ fields: { parent: "not a link" } }))).toBeNull();
  });
});

describe("buildHierarchy", () => {
  const pages = [
    page({ name: "Project Aurora", path: "Projects/Project Aurora.md" }),
    page({ name: "Aurora Web", path: "Projects/Aurora Web.md", fields: { parent: "[[Project Aurora]]" } }),
    page({ name: "Aurora Mobile", path: "People/Aurora Mobile.md", fields: { parent: "[[Project Aurora]]" } }),
    page({ name: "Loose", path: "Loose.md" }),
  ];

  it("nests children under the parent path and relocates them", () => {
    const h = buildHierarchy(pages);
    const kids = h.childrenOf.get("Projects/Project Aurora.md")!;
    expect(kids.map((k) => k.path).sort()).toEqual([
      "People/Aurora Mobile.md",
      "Projects/Aurora Web.md",
    ]);
    // Children (even cross-folder) are hidden from their physical spot.
    expect(h.relocated.has("Projects/Aurora Web.md")).toBe(true);
    expect(h.relocated.has("People/Aurora Mobile.md")).toBe(true);
    // The parent and unrelated notes are not relocated.
    expect(h.relocated.has("Projects/Project Aurora.md")).toBe(false);
    expect(h.relocated.has("Loose.md")).toBe(false);
  });

  it("ignores a parent that doesn't resolve to a note", () => {
    const h = buildHierarchy([page({ name: "Orphan", path: "Orphan.md", fields: { parent: "[[Ghost]]" } })]);
    expect(h.relocated.size).toBe(0);
    expect(h.childrenOf.size).toBe(0);
  });

  it("ignores a self-parent", () => {
    const h = buildHierarchy([page({ name: "Self", path: "Self.md", fields: { parent: "[[Self]]" } })]);
    expect(h.relocated.size).toBe(0);
  });
});
