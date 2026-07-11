import { describe, it, expect } from "vitest";
import { dailyRelPath, parseDailyDate, shiftDays } from "./daily";
import { parseNaturalDate } from "./dateParse";
import { defaultSettings, type Settings } from "../settings";

const base: Settings = { ...defaultSettings };

describe("dailyRelPath", () => {
  it("uses the folder + format", () => {
    const d = new Date(2026, 6, 10); // Jul 10 2026
    expect(dailyRelPath(d, base)).toBe("2026-07-10.md");
    expect(dailyRelPath(d, { ...base, dailyFolder: "Journal" })).toBe("Journal/2026-07-10.md");
    expect(dailyRelPath(d, { ...base, dailyFolder: "Journal/" })).toBe("Journal/2026-07-10.md");
  });
  it("supports slash formats (year folders)", () => {
    const d = new Date(2026, 6, 10);
    expect(dailyRelPath(d, { ...base, dailyFolder: "J", dailyFormat: "YYYY/MM/DD" })).toBe(
      "J/2026/07/10.md"
    );
  });
});

describe("parseDailyDate", () => {
  it("round-trips with dailyRelPath", () => {
    for (const s of [
      base,
      { ...base, dailyFolder: "Journal" },
      { ...base, dailyFolder: "J", dailyFormat: "YYYY/MM/DD" },
    ] as Settings[]) {
      const d = new Date(2026, 6, 10);
      const parsed = parseDailyDate(dailyRelPath(d, s), s);
      expect(parsed).not.toBeNull();
      expect(parsed!.getFullYear()).toBe(2026);
      expect(parsed!.getMonth()).toBe(6);
      expect(parsed!.getDate()).toBe(10);
    }
  });
  it("matches a stem regardless of folder when format has no slash", () => {
    const d = parseDailyDate("anywhere/2026-07-10.md", base);
    expect(d?.getDate()).toBe(10);
  });
  it("rejects non-daily notes", () => {
    expect(parseDailyDate("Project Nimbus.md", base)).toBeNull();
    expect(parseDailyDate("notes/hello.md", base)).toBeNull();
  });
  it("respects a configured folder mismatch", () => {
    const s = { ...base, dailyFolder: "Journal" };
    expect(parseDailyDate("Other/2026-07-10.md", s)).toBeNull();
  });
});

describe("shiftDays", () => {
  it("crosses month boundaries", () => {
    const d = shiftDays(new Date(2026, 6, 31), 1);
    expect(d.getMonth()).toBe(7);
    expect(d.getDate()).toBe(1);
  });
});

describe("parseNaturalDate", () => {
  const today = new Date();
  const iso = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
      d.getDate()
    ).padStart(2, "0")}`;

  it("relative words", () => {
    expect(iso(parseNaturalDate("today")!)).toBe(iso(today));
    expect(iso(parseNaturalDate("tomorrow")!)).toBe(iso(shiftDays(today, 1)));
    expect(iso(parseNaturalDate("yesterday")!)).toBe(iso(shiftDays(today, -1)));
    expect(iso(parseNaturalDate("+3")!)).toBe(iso(shiftDays(today, 3)));
    expect(iso(parseNaturalDate("-2")!)).toBe(iso(shiftDays(today, -2)));
  });
  it("ISO and M/D", () => {
    const d = parseNaturalDate("2026-07-15")!;
    expect([d.getFullYear(), d.getMonth(), d.getDate()]).toEqual([2026, 6, 15]);
    const md = parseNaturalDate("7/15")!;
    expect([md.getMonth(), md.getDate()]).toEqual([6, 15]);
  });
  it("month names", () => {
    const a = parseNaturalDate("jul 15")!;
    expect([a.getMonth(), a.getDate()]).toEqual([6, 15]);
    const b = parseNaturalDate("15 july")!;
    expect([b.getMonth(), b.getDate()]).toEqual([6, 15]);
  });
  it("weekday → upcoming occurrence", () => {
    const d = parseNaturalDate("monday")!;
    expect(d.getDay()).toBe(1);
    expect(d.getTime()).toBeGreaterThan(today.getTime() - 86400000);
  });
  it("returns null for non-dates", () => {
    expect(parseNaturalDate("hello world")).toBeNull();
    expect(parseNaturalDate("")).toBeNull();
  });
});
