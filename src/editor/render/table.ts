// Markdown GFM table (de)serializer for the WYSIWYG table editor.

export type Align = "none" | "left" | "center" | "right";
export interface TableGrid {
  header: string[];
  aligns: Align[];
  rows: string[][];
}

function splitRow(line: string): string[] {
  let s = line.trim();
  if (s.startsWith("|")) s = s.slice(1);
  if (s.endsWith("|")) s = s.slice(0, -1);
  // split on unescaped pipes
  return s.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
}

export function parseTable(md: string): TableGrid {
  const lines = md.split("\n").filter((l) => l.trim());
  const header = splitRow(lines[0] ?? "");
  const aligns: Align[] = splitRow(lines[1] ?? "").map((d) => {
    const t = d.trim();
    const l = t.startsWith(":");
    const r = t.endsWith(":");
    return l && r ? "center" : r ? "right" : l ? "left" : "none";
  });
  const cols = header.length;
  while (aligns.length < cols) aligns.push("none");
  const rows = lines.slice(2).map((l) => {
    const cells = splitRow(l);
    while (cells.length < cols) cells.push("");
    return cells.slice(0, cols);
  });
  return { header, aligns, rows };
}

export function serializeTable(g: TableGrid): string {
  const cols = g.header.length;
  const widths: number[] = [];
  for (let c = 0; c < cols; c++) {
    let w = (g.header[c] ?? "").length;
    for (const row of g.rows) w = Math.max(w, (row[c] ?? "").length);
    widths[c] = Math.max(3, w);
  }
  const esc = (s: string) => s.replace(/\|/g, "\\|");
  const fmt = (cells: string[]) =>
    "| " + cells.map((c, i) => esc(c ?? "").padEnd(widths[i])).join(" | ") + " |";
  const delim =
    "| " +
    g.aligns
      .map((a, i) => {
        // pad the dashes to the column width, keeping any colons
        const dashes = "-".repeat(Math.max(3, widths[i]));
        if (a === "center") return `:${dashes.slice(0, -2)}:`;
        if (a === "right") return `${dashes.slice(0, -1)}:`;
        if (a === "left") return `:${dashes.slice(0, -1)}`;
        return dashes;
      })
      .join(" | ") +
    " |";
  return [fmt(g.header), delim, ...g.rows.map(fmt)].join("\n");
}

export function nextAlign(a: Align): Align {
  return a === "none" ? "left" : a === "left" ? "center" : a === "center" ? "right" : "none";
}
