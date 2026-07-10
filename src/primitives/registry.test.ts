import { describe, it, expect, beforeEach, vi } from "vitest";
import type { BlockRef } from "../lib/api";

// Isolate the primitive logic from its two dependencies: the block-refs cache
// (seeded per-test) and markdown rendering (passthrough so we can assert text).
import type { Atom } from "../lib/api";

const h = vi.hoisted(() => ({
  refs: {} as Record<string, BlockRef[]>,
  atoms: {} as Record<string, Atom[]>,
}));

vi.mock("../dataview/blockrefs", () => ({
  getCachedBlockRefs: (name: string) => h.refs[name.toLowerCase()],
  getCachedAtoms: (name: string) => h.atoms[name.toLowerCase()],
}));
vi.mock("../editor/render/markdown", () => ({
  renderInline: (s: string) => s,
}));

import { primitives, parsePrimitive } from "./registry";

const PAGE = "Project X";
const SELF = "notes/Project X.md";
const ctx = { pageName: PAGE, currentPath: SELF };

/** Build a BlockRef with sensible defaults. */
function ref(over: Partial<BlockRef>): BlockRef {
  return {
    source_path: "daily/2026-07-08.md",
    source_title: "2026-07-08",
    line_start: 0,
    line_end: 0,
    indent: 0,
    kind: "bullet",
    checked: null,
    block_id: null,
    text: "some text",
    ...over,
  };
}

function atom(over: Partial<Atom>): Atom {
  return {
    id: 1,
    kind: "decision",
    text: "we decided",
    source_path: "daily/2026-07-08.md",
    source_heading: null,
    confidence: 0.9,
    substantiation: 0.8,
    evidence: null,
    auto_approved: false,
    status: "approved",
    created_at: 0,
    ...over,
  };
}

beforeEach(() => {
  h.refs = {};
  h.atoms = {};
});

describe("todo primitive", () => {
  it("aggregates task blocks into a checklist, open items first", () => {
    h.refs["project x"] = [
      ref({ kind: "task", checked: true, text: "kickoff", source_path: "notes/Meeting.md", source_title: "Meeting", line_start: 5 }),
      ref({ kind: "task", checked: false, text: "ship draft", line_start: 2 }),
      ref({ kind: "bullet", text: "met [[Alice]]" }), // ignored by todo
    ];
    const html = primitives.todo.render({}, ctx);
    expect(html).toContain("ship draft");
    expect(html).toContain("kickoff");
    // Open ("ship draft") must appear before done ("kickoff").
    expect(html.indexOf("ship draft")).toBeLessThan(html.indexOf("kickoff"));
    // Non-task ref is excluded.
    expect(html).not.toContain("met [[Alice]]");
  });

  it("emits write-back attributes pointing at the source block", () => {
    h.refs["project x"] = [
      ref({ kind: "task", checked: false, text: "do it", source_path: "daily/x.md", line_start: 7 }),
    ];
    const html = primitives.todo.render({}, ctx);
    expect(html).toContain('data-task-path="daily/x.md"');
    expect(html).toContain('data-task-line="7"');
    expect(html).not.toContain("checked"); // unchecked
  });

  it("marks completed tasks as checked", () => {
    h.refs["project x"] = [ref({ kind: "task", checked: true, text: "done", line_start: 1 })];
    expect(primitives.todo.render({}, ctx)).toContain("checked");
  });

  it("excludes blocks from the page's own note (no self-aggregation)", () => {
    h.refs["project x"] = [
      ref({ kind: "task", checked: false, text: "own task", source_path: SELF, line_start: 3 }),
    ];
    expect(primitives.todo.render({}, ctx)).toContain("No linked to-dos.");
  });

  it("shows an empty state when there are no tasks", () => {
    h.refs["project x"] = [ref({ kind: "bullet", text: "just a note" })];
    expect(primitives.todo.render({}, ctx)).toContain("No linked to-dos.");
  });

  it("shows an empty state when the page has no refs at all", () => {
    expect(primitives.todo.render({}, ctx)).toContain("No linked to-dos.");
  });
});

describe("notes primitive", () => {
  it("lists bullet and paragraph blocks but not tasks", () => {
    h.refs["project x"] = [
      ref({ kind: "bullet", text: "a bullet note" }),
      ref({ kind: "para", text: "a paragraph note" }),
      ref({ kind: "task", checked: false, text: "a task", line_start: 4 }),
    ];
    const html = primitives.notes.render({}, ctx);
    expect(html).toContain("a bullet note");
    expect(html).toContain("a paragraph note");
    expect(html).not.toContain("a task");
  });

  it("adds a block anchor when the source block has an id", () => {
    h.refs["project x"] = [ref({ kind: "bullet", text: "anchored", block_id: "abc123" })];
    const html = primitives.notes.render({}, ctx);
    expect(html).toContain('data-anchor="^abc123"');
    expect(html).toContain('data-wikilink="2026-07-08"');
  });

  it("shows an empty state with no notes", () => {
    h.refs["project x"] = [ref({ kind: "task", checked: false, text: "t", line_start: 0 })];
    expect(primitives.notes.render({}, ctx)).toContain("No linked notes.");
  });
});

describe("mentions primitive", () => {
  it("counts mentions per source note, most first", () => {
    h.refs["project x"] = [
      ref({ source_path: "daily/a.md", source_title: "A" }),
      ref({ source_path: "daily/a.md", source_title: "A" }),
      ref({ source_path: "notes/B.md", source_title: "B" }),
    ];
    const html = primitives.mentions.render({}, ctx);
    expect(html).toContain("A");
    expect(html).toContain("B");
    // A (2 mentions) is listed before B (1 mention).
    expect(html.indexOf(">A<")).toBeLessThan(html.indexOf(">B<"));
    expect(html).toContain(">2<"); // A's count badge
  });

  it("shows an empty state with no mentions", () => {
    expect(primitives.mentions.render({}, ctx)).toContain("No mentions.");
  });
});

describe("parsePrimitive", () => {
  it("parses the type and params, lowercasing keys", () => {
    const { type, params } = parsePrimitive("type: Todo\nScope: this\nkinds: [action_item]");
    expect(type).toBe("todo");
    expect(params.scope).toBe("this");
    expect(params.kinds).toBe("[action_item]");
  });

  it("returns an empty type when none is given", () => {
    expect(parsePrimitive("scope: this").type).toBe("");
  });
});

describe("atom-backed primitives", () => {
  it("decisions shows only decision atoms with their source note", () => {
    h.atoms["project x"] = [
      atom({ kind: "decision", text: "ship beta first", source_path: "daily/2026-07-08.md" }),
      atom({ kind: "pain_point", text: "unclear scope" }),
    ];
    const html = primitives.decisions.render({}, ctx);
    expect(html).toContain("ship beta first");
    expect(html).not.toContain("unclear scope");
    expect(html).toContain('data-wikilink="2026-07-08"');
  });

  it("pain-points shows only pain_point atoms", () => {
    h.atoms["project x"] = [
      atom({ kind: "pain_point", text: "onboarding is slow" }),
      atom({ kind: "decision", text: "a decision" }),
    ];
    const html = primitives["pain-points"].render({}, ctx);
    expect(html).toContain("onboarding is slow");
    expect(html).not.toContain("a decision");
  });

  it("insights empty state when no matching atoms or blocks", () => {
    h.atoms["project x"] = [atom({ kind: "decision", text: "d" })];
    expect(primitives.insights.render({}, ctx)).toContain("No insights yet.");
  });

  it("empty state when the page has no atoms or blocks at all", () => {
    expect(primitives.decisions.render({}, ctx)).toContain("No decisions yet.");
  });

  it("surfaces journal blocks that read like a decision, without any atoms", () => {
    h.refs["project x"] = [
      ref({ kind: "bullet", text: "Decision: ship the beta first", source_title: "2026-07-08" }),
      ref({ kind: "bullet", text: "just a normal note" }),
    ];
    const html = primitives.decisions.render({}, ctx);
    expect(html).toContain("Decision: ship the beta first");
    expect(html).not.toContain("just a normal note");
    expect(html).toContain('data-wikilink="2026-07-08"');
  });

  it("pain-points matches Problem/Blocker-prefixed blocks", () => {
    h.refs["project x"] = [
      ref({ kind: "bullet", text: "Problem: setup is confusing" }),
      ref({ kind: "bullet", text: "Blocker: waiting on legal" }),
      ref({ kind: "bullet", text: "unrelated" }),
    ];
    const html = primitives["pain-points"].render({}, ctx);
    expect(html).toContain("Problem: setup is confusing");
    expect(html).toContain("Blocker: waiting on legal");
    expect(html).not.toContain("unrelated");
  });

  it("dedupes a block whose text matches an atom (atom wins)", () => {
    h.atoms["project x"] = [
      atom({ kind: "decision", text: "Decision: ship beta first", source_path: "notes/atomsrc.md" }),
    ];
    h.refs["project x"] = [
      ref({ kind: "bullet", text: "Decision: ship beta first", source_title: "2026-07-08" }),
    ];
    const html = primitives.decisions.render({}, ctx);
    // Only one row, credited to the atom's source note (not the journal block).
    expect(html.match(/<li>/g)?.length).toBe(1);
    expect(html).toContain('data-wikilink="atomsrc"');
  });
});

describe("registry", () => {
  it("registers all six primitives", () => {
    expect(Object.keys(primitives).sort()).toEqual([
      "decisions",
      "insights",
      "mentions",
      "notes",
      "pain-points",
      "todo",
    ]);
  });
});
