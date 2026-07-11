import { formatDate, type Settings } from "../settings";

/** The vault-relative path for a given date's daily note. */
export function dailyRelPath(date: Date, s: Settings): string {
  const folder = s.dailyFolder.trim().replace(/\/+$/, "");
  const fname = formatDate(s.dailyFormat || "YYYY-MM-DD", date);
  return `${folder ? folder + "/" : ""}${fname}.md`;
}

/** Escape a literal (non-token) character for use in a RegExp. */
function escapeRe(ch: string): string {
  return ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * If `relPath` is a daily note under the configured folder/format, return the
 * date it represents; otherwise `null`. Reverses `dailyFormat` into a regex.
 * Handles formats that contain `/` (e.g. `YYYY/MM/DD` year folders) and, for
 * slash-free formats, matches leniently on the filename stem.
 */
export function parseDailyDate(relPath: string, s: Settings): Date | null {
  const fmt = s.dailyFormat || "YYYY-MM-DD";
  let rest = relPath.replace(/\.md$/i, "");

  const folder = s.dailyFolder.trim().replace(/\/+$/, "");
  if (folder) {
    if (rest !== folder && !rest.startsWith(folder + "/")) return null;
    rest = rest.slice(folder.length + 1);
  }
  if (!fmt.includes("/")) rest = rest.replace(/^.*\//, ""); // just the stem

  const tokens: string[] = [];
  let re = "";
  for (let i = 0; i < fmt.length; ) {
    const four = fmt.slice(i, i + 4);
    const two = fmt.slice(i, i + 2);
    if (four === "YYYY") { re += "(\\d{4})"; tokens.push("Y"); i += 4; }
    else if (two === "MM") { re += "(\\d{2})"; tokens.push("M"); i += 2; }
    else if (two === "DD") { re += "(\\d{2})"; tokens.push("D"); i += 2; }
    else if (two === "HH") { re += "(\\d{2})"; tokens.push("H"); i += 2; }
    else if (two === "mm") { re += "(\\d{2})"; tokens.push("i"); i += 2; }
    else if (two === "ss") { re += "(\\d{2})"; tokens.push("s"); i += 2; }
    else { re += escapeRe(fmt[i]); i += 1; }
  }

  const m = new RegExp("^" + re + "$").exec(rest);
  if (!m) return null;

  const now = new Date();
  let Y = now.getFullYear(), Mo = 0, D = 1, H = 0, Mi = 0, S = 0;
  tokens.forEach((t, idx) => {
    const v = parseInt(m[idx + 1], 10);
    if (t === "Y") Y = v;
    else if (t === "M") Mo = v - 1;
    else if (t === "D") D = v;
    else if (t === "H") H = v;
    else if (t === "i") Mi = v;
    else if (t === "s") S = v;
  });
  const d = new Date(Y, Mo, D, H, Mi, S);
  return isNaN(d.getTime()) ? null : d;
}

/** A new Date offset from `date` by `n` days. */
export function shiftDays(date: Date, n: number): Date {
  const d = new Date(date);
  d.setDate(d.getDate() + n);
  return d;
}

export function sameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}
