import { describe, it, expect } from "vitest";
import { ancestorNames, buildHierarchy, isDescendant, pagesByName, parentName } from "./hierarchy";
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

describe("isDescendant", () => {
  // A ─ B ─ C  (C's parent is B, B's parent is A)
  const h = buildHierarchy([
    page({ name: "A", path: "A.md" }),
    page({ name: "B", path: "B.md", fields: { parent: "[[A]]" } }),
    page({ name: "C", path: "C.md", fields: { parent: "[[B]]" } }),
    page({ name: "Other", path: "Other.md" }),
  ]);

  it("finds direct and transitive descendants", () => {
    expect(isDescendant(h, "A.md", "B.md")).toBe(true);
    expect(isDescendant(h, "A.md", "C.md")).toBe(true); // transitive
    expect(isDescendant(h, "B.md", "C.md")).toBe(true);
  });

  it("is false for non-descendants, self, and unrelated notes", () => {
    expect(isDescendant(h, "C.md", "A.md")).toBe(false); // upward
    expect(isDescendant(h, "A.md", "A.md")).toBe(false); // self
    expect(isDescendant(h, "A.md", "Other.md")).toBe(false);
  });

  it("blocks a reparent that would form a cycle (drop A onto C)", () => {
    // Making A a child of its own descendant C must be rejected.
    expect(isDescendant(h, "A.md", "C.md")).toBe(true);
  });
});

describe("ancestorNames", () => {
  // Root ─ Project Aurora ─ Aurora Web, plus a same-named "Aurora Web" under Nimbus.
  const pages = [
    page({ name: "Root", path: "Root.md" }),
    page({ name: "Project Aurora", path: "Projects/Project Aurora.md", fields: { parent: "[[Root]]" } }),
    page({ name: "Aurora Web", path: "Projects/Aurora Web.md", fields: { parent: "[[Project Aurora]]" } }),
    page({ name: "Nimbus", path: "Clients/Nimbus.md" }),
    page({ name: "Aurora Web", path: "Clients/Aurora Web.md", fields: { parent: "[[Nimbus]]" } }),
    page({ name: "Loose", path: "Loose.md" }),
  ];
  const byName = pagesByName(pages);

  it("returns the chain root → parent (leaf excluded)", () => {
    const web = pages[2];
    expect(ancestorNames(web, byName)).toEqual(["Root", "Project Aurora"]);
  });

  it("gives same-named notes distinct chains", () => {
    const nimbusWeb = pages[4];
    expect(ancestorNames(nimbusWeb, byName)).toEqual(["Nimbus"]);
  });

  it("is empty for a note with no parent", () => {
    expect(ancestorNames(pages[5], byName)).toEqual([]);
  });

  it("stops at a parent that doesn't resolve", () => {
    const orphan = page({ name: "Orphan", path: "Orphan.md", fields: { parent: "[[Ghost]]" } });
    expect(ancestorNames(orphan, pagesByName([orphan]))).toEqual([]);
  });

  it("terminates on a cycle (A ↔ B)", () => {
    const cyc = [
      page({ name: "A", path: "A.md", fields: { parent: "[[B]]" } }),
      page({ name: "B", path: "B.md", fields: { parent: "[[A]]" } }),
    ];
    const m = pagesByName(cyc);
    expect(ancestorNames(cyc[0], m)).toEqual(["B"]); // one hop, then cycle guard stops
  });
});
