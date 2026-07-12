import { describe, it, expect } from "vitest";
import {
  parseFrontmatter,
  serializeFrontmatter,
  applyFrontmatter,
  type Prop,
} from "./frontmatter";

describe("parseFrontmatter", () => {
  it("parses ordered key/value pairs and strips quotes", () => {
    const c = '---\ntype: project\nparent: "[[Project Aurora]]"\n---\n\n# X\n';
    const { props, has, end } = parseFrontmatter(c);
    expect(has).toBe(true);
    expect(props).toEqual([
      { key: "type", value: "project" },
      { key: "parent", value: "[[Project Aurora]]" },
    ]);
    expect(c.slice(end)).toBe("\n# X\n");
  });
  it("returns empty for no frontmatter", () => {
    const r = parseFrontmatter("# Just a note\n");
    expect(r.has).toBe(false);
    expect(r.props).toEqual([]);
    expect(r.end).toBe(0);
  });
});

describe("serializeFrontmatter", () => {
  it("emits a block and quotes values that need it", () => {
    expect(serializeFrontmatter([{ key: "type", value: "project" }])).toBe(
      "---\ntype: project\n---\n"
    );
    expect(serializeFrontmatter([{ key: "parent", value: "[[X]]" }])).toBe(
      '---\nparent: "[[X]]"\n---\n'
    );
  });
  it("drops blank-key rows and returns empty when nothing remains", () => {
    expect(serializeFrontmatter([{ key: "", value: "x" }])).toBe("");
    expect(serializeFrontmatter([])).toBe("");
  });
  it("round-trips through parse", () => {
    const props: Prop[] = [
      { key: "type", value: "person" },
      { key: "parent", value: "[[Project Aurora]]" },
      { key: "status", value: "active" },
    ];
    expect(parseFrontmatter(serializeFrontmatter(props)).props).toEqual(props);
  });
});

describe("applyFrontmatter", () => {
  const withFm = "---\ntype: project\n---\n\n# Aurora\n";

  it("edits an existing block, preserving the body", () => {
    const out = applyFrontmatter(withFm, [{ key: "type", value: "epic" }]);
    expect(out).toBe("---\ntype: epic\n---\n\n# Aurora\n");
  });
  it("adds a property", () => {
    const out = applyFrontmatter(withFm, [
      { key: "type", value: "project" },
      { key: "status", value: "active" },
    ]);
    expect(out).toBe("---\ntype: project\nstatus: active\n---\n\n# Aurora\n");
  });
  it("removes the block when no props remain", () => {
    expect(applyFrontmatter(withFm, [])).toBe("# Aurora\n");
  });
  it("prepends a block when the note has none", () => {
    const out = applyFrontmatter("# Hello\n", [{ key: "type", value: "person" }]);
    expect(out).toBe("---\ntype: person\n---\n\n# Hello\n");
  });
});
