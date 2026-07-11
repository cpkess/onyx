import { shiftDays } from "./daily";

const MONTHS = [
  "jan", "feb", "mar", "apr", "may", "jun",
  "jul", "aug", "sep", "oct", "nov", "dec",
];
const WEEKDAYS = [
  "sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday",
];

function at(y: number, m: number, d: number): Date | null {
  const dt = new Date(y, m, d);
  return isNaN(dt.getTime()) ? null : dt;
}

/**
 * Parse a human date expression into a Date, or `null` if it isn't one.
 * Understands: today/tomorrow/yesterday, `+n`/`-n` days, ISO `YYYY-MM-DD`
 * (or `/`), `M/D` (current year), `jul 15` / `15 jul`, and weekday names
 * (next upcoming occurrence). Dependency-free.
 */
export function parseNaturalDate(input: string): Date | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  const today = new Date();

  if (s === "today") return at(today.getFullYear(), today.getMonth(), today.getDate());
  if (s === "tomorrow" || s === "tmr") return shiftDays(today, 1);
  if (s === "yesterday") return shiftDays(today, -1);

  let m = /^([+-]\d+)\s*(?:d|days?)?$/.exec(s);
  if (m) return shiftDays(today, parseInt(m[1], 10));

  m = /^(\d{4})[-/](\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return at(+m[1], +m[2] - 1, +m[3]);

  m = /^(\d{1,2})[-/](\d{1,2})$/.exec(s);
  if (m) return at(today.getFullYear(), +m[1] - 1, +m[2]);

  // "jul 15" / "july 15" or "15 jul"
  let monIdx = -1;
  let day = -1;
  m = /^([a-z]+)\.?\s+(\d{1,2})$/.exec(s);
  if (m) {
    monIdx = MONTHS.findIndex((mo) => m![1].startsWith(mo));
    day = +m[2];
  } else {
    m = /^(\d{1,2})\s+([a-z]+)\.?$/.exec(s);
    if (m) {
      monIdx = MONTHS.findIndex((mo) => m![2].startsWith(mo));
      day = +m[1];
    }
  }
  if (monIdx >= 0 && day >= 1 && day <= 31) {
    return at(today.getFullYear(), monIdx, day);
  }

  // Weekday name → next upcoming occurrence (excluding today).
  if (s.length >= 3) {
    const wd = WEEKDAYS.findIndex((w) => w.startsWith(s));
    if (wd >= 0) {
      const diff = (wd - today.getDay() + 7) % 7 || 7;
      return shiftDays(today, diff);
    }
  }

  return null;
}
