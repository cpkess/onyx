import { describe, it, expect } from "vitest";
import {
  serializeBadgeFormat,
  parseBadgeFormat,
  splitDataviewSource,
  matchBadge,
  badgeColorHex,
  BADGE_COLORS,
  type BadgeFormat,
} from "./badges";

const fmt: BadgeFormat = {
  status: [
    { value: "Done", color: "green" },
    { value: "Blocked", color: "red" },
  ],
};

describe("serialize/parse round-trip", () => {
  it("round-trips a format through the sentinel line", () => {
    const line = serializeBadgeFormat(fmt);
    expect(line.startsWith("%% onyx-badges:")).toBe(true);
    expect(line.endsWith("%%")).toBe(true);
    expect(parseBadgeFormat(line)).toEqual(fmt);
  });

  it("serializes empty/ruleless formats to an empty string", () => {
    expect(serializeBadgeFormat({})).toBe("");
    expect(serializeBadgeFormat({ status: [] })).toBe("");
  });

  it("returns null for a body with no sentinel line", () => {
    expect(parseBadgeFormat("TABLE status FROM x")).toBeNull();
  });

  it("returns null for a malformed sentinel line", () => {
    expect(parseBadgeFormat("%% onyx-badges: {not json} %%")).toBeNull();
  });
});

describe("splitDataviewSource", () => {
  it("strips the sentinel line and returns clean DQL + format", () => {
    const body = `TABLE status AS Status FROM "Projects"\n${serializeBadgeFormat(fmt)}`;
    const { dql, format } = splitDataviewSource(body);
    expect(dql).toBe('TABLE status AS Status FROM "Projects"');
    expect(format).toEqual(fmt);
  });

  it("passes plain DQL through untouched with null format", () => {
    const { dql, format } = splitDataviewSource("TABLE status FROM x");
    expect(dql).toBe("TABLE status FROM x");
    expect(format).toBeNull();
  });
});

describe("matchBadge", () => {
  it("matches header and value case-insensitively", () => {
    expect(matchBadge(fmt, "Status", "done")).toBe(BADGE_COLORS.green);
    expect(matchBadge(fmt, "status", "Blocked")).toBe(BADGE_COLORS.red);
  });

  it("returns null for unknown header, unknown value, or missing format", () => {
    expect(matchBadge(fmt, "priority", "Done")).toBeNull();
    expect(matchBadge(fmt, "status", "In Progress")).toBeNull();
    expect(matchBadge(null, "status", "Done")).toBeNull();
    expect(matchBadge(fmt, undefined, "Done")).toBeNull();
  });
});

describe("badgeColorHex", () => {
  it("resolves a named color, else returns the raw value", () => {
    expect(badgeColorHex("green")).toBe(BADGE_COLORS.green);
    expect(badgeColorHex("#123456")).toBe("#123456");
  });
});
