import { EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { renderMarkdown, renderInline } from "./markdown";
import { getHost } from "./host";
import { loadKatex, loadMermaid, mathCache, mermaidCache, enhanceRendered } from "./enhance";
import { api, type AtomFilter } from "../../lib/api";
import { kindLabel, KIND_COLOR } from "../../features/atoms/kinds";
import { runDql, runInline, toText, type DvResult } from "../../dataview/engine";
import { DvLink } from "../../dataview/value";
import { getCachedPages, invalidatePages } from "../../dataview/pages";
import { parseTable, serializeTable, nextAlign, type TableGrid } from "./table";

/** Extract a heading section or `^block` from note content for embeds. */
function extractSection(content: string, anchor: string): string {
  if (!anchor) return content;
  const lines = content.split("\n");
  if (anchor.startsWith("^")) {
    const id = anchor.slice(1);
    const line = lines.find((l) => l.trimEnd().endsWith("^" + id));
    return line ? line.replace(/\s*\^[\w-]+\s*$/, "") : content;
  }
  const target = anchor.toLowerCase();
  const idx = lines.findIndex((l) => {
    const m = l.match(/^#{1,6}\s+(.*)$/);
    return m && m[1].trim().toLowerCase() === target;
  });
  if (idx === -1) return content;
  const level = (lines[idx].match(/^#+/) ?? ["#"])[0].length;
  let end = lines.length;
  for (let i = idx + 1; i < lines.length; i++) {
    const m = lines[i].match(/^(#{1,6})\s+/);
    if (m && m[1].length <= level) {
      end = i;
      break;
    }
  }
  return lines.slice(idx, end).join("\n");
}

export class ImageWidget extends WidgetType {
  constructor(readonly target: string, readonly alt: string, readonly width: string) {
    super();
  }
  eq(o: ImageWidget) {
    return o.target === this.target && o.alt === this.alt && o.width === this.width;
  }
  toDOM() {
    const img = document.createElement("img");
    img.className = "onyx-image";
    img.alt = this.alt;
    if (this.width) {
      img.style.width = /^\d+$/.test(this.width) ? `${this.width}px` : this.width;
    }
    if (/^(https?:|data:)/.test(this.target)) {
      img.src = this.target;
    } else {
      getHost()
        .resolveAsset(this.target)
        .then((src) => {
          if (src) img.src = convertFileSrc(src);
        });
    }
    return img;
  }
}

export class EmbedWidget extends WidgetType {
  constructor(readonly name: string, readonly anchor: string) {
    super();
  }
  eq(o: EmbedWidget) {
    return o.name === this.name && o.anchor === this.anchor;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-embed onyx-rendered";
    const head = document.createElement("div");
    head.className = "onyx-embed-title";
    const a = document.createElement("a");
    a.className = "tok-wikilink";
    a.setAttribute("data-wikilink", this.name);
    if (this.anchor) a.setAttribute("data-anchor", this.anchor);
    a.textContent = this.anchor ? `${this.name} › ${this.anchor}` : this.name;
    head.appendChild(a);
    el.appendChild(head);

    const body = document.createElement("div");
    body.className = "onyx-embed-body";
    body.textContent = "Loading…";
    el.appendChild(body);

    const host = getHost();
    host
      .resolvePath(this.name)
      .then(async (path) => {
        if (!path) {
          body.textContent = "Note not found.";
          return;
        }
        const content = await host.readNote(path);
        if (content == null) {
          body.textContent = "Note not found.";
          return;
        }
        body.innerHTML = renderMarkdown(extractSection(content, this.anchor));
        enhanceRendered(body);
      })
      .catch(() => {
        body.textContent = "Could not load note.";
      });
    return el;
  }
}

export class PropertiesWidget extends WidgetType {
  constructor(readonly entries: [string, string][]) {
    super();
  }
  eq(o: PropertiesWidget) {
    return JSON.stringify(o.entries) === JSON.stringify(this.entries);
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-props onyx-rendered";
    for (const [k, v] of this.entries) {
      const row = document.createElement("div");
      row.className = "onyx-prop";
      const key = document.createElement("span");
      key.className = "onyx-prop-key";
      key.textContent = k;
      const val = document.createElement("span");
      val.className = "onyx-prop-val";
      val.textContent = v;
      row.append(key, val);
      el.appendChild(row);
    }
    return el;
  }
}

/** A collapsed "AI context" badge standing in for a hidden `<!--ai … -->` HCM
 *  block. Clicking it places the cursor inside the block to reveal the source. */
export class HcmBadgeWidget extends WidgetType {
  constructor(
    readonly instruction: string,
    readonly from: number,
    readonly to: number
  ) {
    super();
  }
  eq(o: HcmBadgeWidget) {
    return o.instruction === this.instruction && o.from === this.from;
  }
  toDOM(view: EditorView) {
    const el = document.createElement("div");
    el.className = "onyx-hcm onyx-rendered";
    el.textContent = "✨ AI context";
    el.title = this.instruction || "AI context for this section";
    el.addEventListener("mousedown", (e) => {
      e.preventDefault();
      // Put the cursor just inside the comment so the raw block reveals.
      const pos = Math.min(this.from + 5, view.state.doc.length);
      view.dispatch({ selection: { anchor: pos } });
      view.focus();
    });
    return el;
  }
  ignoreEvent() {
    return false;
  }
}

const CALLOUT_ICONS: Record<string, string> = {
  note: "🗒️",
  abstract: "📋",
  summary: "📋",
  info: "ℹ️",
  todo: "☑️",
  tip: "💡",
  hint: "💡",
  important: "❗",
  success: "✅",
  check: "✅",
  question: "❓",
  faq: "❓",
  warning: "⚠️",
  caution: "⚠️",
  attention: "⚠️",
  failure: "❌",
  danger: "🔥",
  error: "🔥",
  bug: "🐛",
  example: "📑",
  quote: "❝",
};

export class CalloutWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly title: string,
    readonly body: string
  ) {
    super();
  }
  eq(o: CalloutWidget) {
    return o.kind === this.kind && o.title === this.title && o.body === this.body;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = `onyx-callout onyx-callout-${this.kind} onyx-rendered`;
    const head = document.createElement("div");
    head.className = "onyx-callout-title";
    const icon = CALLOUT_ICONS[this.kind] ?? "🗒️";
    head.textContent = `${icon}  ${this.title || this.kind.replace(/^\w/, (c) => c.toUpperCase())}`;
    el.appendChild(head);
    if (this.body.trim()) {
      const body = document.createElement("div");
      body.className = "onyx-callout-body";
      body.innerHTML = renderMarkdown(this.body);
      el.appendChild(body);
    }
    return el;
  }
}

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }
  eq(o: CheckboxWidget) {
    return o.checked === this.checked;
  }
  toDOM(view: EditorView) {
    const wrap = document.createElement("span");
    wrap.className = "onyx-checkbox";
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = this.checked;
    input.addEventListener("mousedown", (e) => {
      e.preventDefault();
      const pos = view.posAtDOM(wrap);
      const slice = view.state.doc.sliceString(pos, pos + 3); // "[ ]" / "[x]"
      const open = slice.indexOf("[");
      if (open === -1) return;
      const charPos = pos + open + 1;
      const cur = view.state.doc.sliceString(charPos, charPos + 1).toLowerCase();
      view.dispatch({
        changes: { from: charPos, to: charPos + 1, insert: cur === "x" ? " " : "x" },
      });
    });
    wrap.appendChild(input);
    return wrap;
  }
}

export class TableWidget extends WidgetType {
  constructor(readonly source: string) {
    super();
  }
  eq(o: TableWidget) {
    return o.source === this.source;
  }
  ignoreEvent() {
    return true; // let our cell editing handle events; don't move the CM cursor
  }
  toDOM(view: EditorView) {
    const grid = parseTable(this.source);
    const wrap = document.createElement("div");
    wrap.className = "onyx-table onyx-rendered onyx-table-edit";
    // Mark non-editable so CodeMirror's DOM observer treats the widget as atomic
    // and never tries to interpret the <input> cells as document edits.
    wrap.contentEditable = "false";

    const cellInput = (cls: string, value: string) => {
      const inp = document.createElement("input");
      inp.className = cls;
      inp.type = "text";
      inp.value = value;
      inp.spellcheck = false;
      inp.addEventListener("blur", () => commit(readGrid()));
      return inp;
    };
    const readGrid = (): TableGrid => {
      const header = Array.from(wrap.querySelectorAll<HTMLInputElement>(".dv-h")).map((e) =>
        e.value.trim()
      );
      const rows = Array.from(wrap.querySelectorAll<HTMLElement>("tbody tr")).map((tr) =>
        Array.from(tr.querySelectorAll<HTMLInputElement>(".dv-c")).map((e) => e.value.trim())
      );
      return { header, aligns: grid.aligns.slice(0, header.length), rows };
    };
    const commit = (g: TableGrid) => {
      const md = serializeTable(g);
      if (md === this.source) return;
      const from = view.posAtDOM(wrap);
      view.dispatch({ changes: { from, to: from + this.source.length, insert: md } });
    };
    const btnDown = (fn: () => void) => (e: Event) => {
      e.preventDefault();
      e.stopPropagation();
      fn();
    };

    const table = document.createElement("table");
    const thead = document.createElement("thead");
    const htr = document.createElement("tr");
    grid.header.forEach((h, c) => {
      const th = document.createElement("th");
      th.style.textAlign = grid.aligns[c] === "none" ? "left" : grid.aligns[c];
      const cell = cellInput("dv-h", h);
      const tools = document.createElement("span");
      tools.className = "onyx-th-tools";
      const align = document.createElement("button");
      align.textContent = "⇄";
      align.title = "Cycle alignment";
      align.addEventListener(
        "mousedown",
        btnDown(() => {
          const g = readGrid();
          g.aligns[c] = nextAlign(g.aligns[c] ?? "none");
          commit(g);
        })
      );
      const del = document.createElement("button");
      del.textContent = "✕";
      del.title = "Delete column";
      del.addEventListener(
        "mousedown",
        btnDown(() => {
          const g = readGrid();
          g.header.splice(c, 1);
          g.aligns.splice(c, 1);
          g.rows.forEach((r) => r.splice(c, 1));
          commit(g);
        })
      );
      tools.append(align, del);
      th.append(cell, tools);
      htr.appendChild(th);
    });
    const addCol = document.createElement("th");
    addCol.className = "onyx-addcol";
    addCol.textContent = "＋";
    addCol.title = "Add column";
    addCol.addEventListener(
      "mousedown",
      btnDown(() => {
        const g = readGrid();
        g.header.push("New");
        g.aligns.push("none");
        g.rows.forEach((r) => r.push(""));
        commit(g);
      })
    );
    htr.appendChild(addCol);
    thead.appendChild(htr);
    table.appendChild(thead);

    const tbody = document.createElement("tbody");
    grid.rows.forEach((row, r) => {
      const tr = document.createElement("tr");
      row.forEach((cellText, c) => {
        const td = document.createElement("td");
        td.style.textAlign = grid.aligns[c] === "none" ? "left" : grid.aligns[c];
        td.appendChild(cellInput("dv-c", cellText));
        tr.appendChild(td);
      });
      const actions = document.createElement("td");
      actions.className = "onyx-actions";
      const delRow = document.createElement("button");
      delRow.textContent = "✕";
      delRow.title = "Delete row";
      delRow.addEventListener(
        "mousedown",
        btnDown(() => {
          const g = readGrid();
          g.rows.splice(r, 1);
          commit(g);
        })
      );
      actions.appendChild(delRow);
      tr.appendChild(actions);
      tbody.appendChild(tr);
    });
    table.appendChild(tbody);
    wrap.appendChild(table);

    const addRow = document.createElement("button");
    addRow.className = "onyx-addrow";
    addRow.textContent = "＋ Row";
    addRow.addEventListener(
      "mousedown",
      btnDown(() => {
        const g = readGrid();
        g.rows.push(new Array(g.header.length).fill(""));
        commit(g);
      })
    );
    wrap.appendChild(addRow);
    return wrap;
  }
}

export class CodeHeaderWidget extends WidgetType {
  constructor(readonly lang: string, readonly code: string) {
    super();
  }
  eq(o: CodeHeaderWidget) {
    return o.lang === this.lang && o.code === this.code;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-codeheader";
    const label = document.createElement("span");
    label.className = "onyx-codeheader-lang";
    label.textContent = this.lang || "text";
    const btn = document.createElement("button");
    btn.className = "onyx-codeheader-copy";
    btn.textContent = "Copy";
    btn.addEventListener("mousedown", (e) => {
      e.preventDefault();
      navigator.clipboard?.writeText(this.code).then(() => {
        btn.textContent = "Copied";
        setTimeout(() => (btn.textContent = "Copy"), 1200);
      });
    });
    el.appendChild(label);
    el.appendChild(btn);
    return el;
  }
}

export class FootnoteRefWidget extends WidgetType {
  constructor(readonly id: string) {
    super();
  }
  eq(o: FootnoteRefWidget) {
    return o.id === this.id;
  }
  toDOM() {
    const sup = document.createElement("sup");
    sup.className = "onyx-footnote-ref";
    sup.textContent = this.id;
    return sup;
  }
}

// ---- Math (KaTeX, lazy-loaded) ----

export class MathWidget extends WidgetType {
  constructor(readonly formula: string, readonly display: boolean) {
    super();
  }
  eq(o: MathWidget) {
    return o.formula === this.formula && o.display === this.display;
  }
  toDOM() {
    const el = document.createElement(this.display ? "div" : "span");
    el.className = this.display ? "onyx-math onyx-math-block" : "onyx-math";
    const key = (this.display ? "D:" : "I:") + this.formula;
    const cached = mathCache.get(key);
    if (cached) {
      el.innerHTML = cached;
      return el;
    }
    el.textContent = this.formula;
    loadKatex().then(({ default: katex }) => {
      try {
        const html = katex.renderToString(this.formula, {
          displayMode: this.display,
          throwOnError: false,
        });
        mathCache.set(key, html);
        el.innerHTML = html;
      } catch {
        /* leave raw formula */
      }
    });
    return el;
  }
}

// ---- Mermaid diagrams (lazy-loaded) ----

let mermaidSeq = 0;

export class MermaidWidget extends WidgetType {
  constructor(readonly code: string) {
    super();
  }
  eq(o: MermaidWidget) {
    return o.code === this.code;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-mermaid onyx-rendered";
    const cached = mermaidCache.get(this.code);
    if (cached) {
      el.innerHTML = cached;
      return el;
    }
    el.textContent = "Rendering diagram…";
    loadMermaid().then(async ({ default: mermaid }) => {
      try {
        const { svg } = await mermaid.render(`onyx-mermaid-${mermaidSeq++}`, this.code);
        mermaidCache.set(this.code, svg);
        el.innerHTML = svg;
      } catch (e) {
        el.className = "onyx-mermaid-error";
        el.textContent = `Mermaid error: ${e}`;
      }
    });
    return el;
  }
}

export class HrWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-hr";
    el.appendChild(document.createElement("hr"));
    return el;
  }
}

export class BulletWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "onyx-bullet";
    el.textContent = "•";
    return el;
  }
}

// ---- Dataview ----

function escAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function cellHtml(v: unknown): string {
  if (v == null) return "";
  if (v instanceof DvLink) {
    const label = v.display ?? v.name;
    return `<a class="tok-wikilink" data-wikilink="${escAttr(v.name)}">${escHtml(label)}</a>`;
  }
  if (Array.isArray(v)) return v.map(cellHtml).join(", ");
  if (typeof v === "boolean") return v ? "✓" : "✗";
  if (typeof v === "number") return String(v);
  if (v instanceof Date) return escHtml(toText(v));
  if (typeof v === "object") return escHtml(toText(v));
  return renderInline(String(v));
}

function renderDvResult(res: DvResult): string {
  if (res.kind === "error") return `<div class="onyx-dv-error">${escHtml(res.message)}</div>`;

  if (res.kind === "table") {
    const head = `<thead><tr>${res.headers.map((h) => `<th>${escHtml(h)}</th>`).join("")}</tr></thead>`;
    const body = (rows: unknown[][]) =>
      rows.map((r) => `<tr>${r.map((c) => `<td>${cellHtml(c)}</td>`).join("")}</tr>`).join("");
    if (res.groups) {
      return res.groups
        .map(
          (g) =>
            `<div class="onyx-dv-group"><div class="onyx-dv-key">${cellHtml(g.key)}</div>` +
            `<table>${head}<tbody>${body(g.rows)}</tbody></table></div>`
        )
        .join("");
    }
    if (res.rows.length === 0) return `<div class="onyx-dv-empty">No results.</div>`;
    return `<table>${head}<tbody>${body(res.rows)}</tbody></table>`;
  }

  if (res.kind === "list") {
    const ul = (items: unknown[]) => `<ul>${items.map((i) => `<li>${cellHtml(i)}</li>`).join("")}</ul>`;
    if (res.groups) return res.groups.map((g) => `<div class="onyx-dv-key">${cellHtml(g.key)}</div>${ul(g.items)}`).join("");
    if (res.items.length === 0) return `<div class="onyx-dv-empty">No results.</div>`;
    return ul(res.items);
  }

  if (res.kind === "task") {
    if (res.tasks.length === 0) return `<div class="onyx-dv-empty">No tasks.</div>`;
    return `<ul class="onyx-dv-tasks">${res.tasks
      .map(
        (t) =>
          `<li><label><input type="checkbox" ${t.checked ? "checked" : ""} ` +
          `data-task-path="${escAttr(t.path)}" data-task-line="${t.line}"> ${renderInline(t.text)}</label></li>`
      )
      .join("")}</ul>`;
  }

  // calendar — lightweight: dates with their entries
  const days = Object.keys(res.byDate).sort();
  if (days.length === 0) return `<div class="onyx-dv-empty">No dated entries.</div>`;
  return `<div class="onyx-dv-cal">${days
    .map(
      (d) =>
        `<div class="onyx-dv-calday"><div class="onyx-dv-key">${escHtml(d)}</div>` +
        res.byDate[d]
          .map((e) => `<a class="tok-wikilink" data-wikilink="${escAttr(e.label)}">${escHtml(e.label)}</a>`)
          .join("") +
        `</div>`
    )
    .join("")}</div>`;
}

export class DataviewWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly version: number,
    readonly currentPath: string | null
  ) {
    super();
  }
  eq(o: DataviewWidget) {
    return o.source === this.source && o.version === this.version && o.currentPath === this.currentPath;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-dataview onyx-rendered";
    el.innerHTML = renderDvResult(runDql(this.source, getCachedPages(), this.currentPath));
    el.addEventListener("mousedown", (e) => {
      const input = (e.target as HTMLElement)?.closest?.(
        "input[data-task-path]"
      ) as HTMLInputElement | null;
      if (input) {
        e.preventDefault();
        const path = input.getAttribute("data-task-path")!;
        const line = Number(input.getAttribute("data-task-line"));
        api.toggleTask(path, line).then(() => invalidatePages()).catch(() => {});
      }
    });
    return el;
  }
}

// ---- Atoms (knowledge units) ----

/** Parse a minimal atoms-block query into an AtomFilter. Supported lines:
 *  `kind: pain_point`, `source: .` (current note) or a path, `relation: contradicts`,
 *  `search: text`, or a bare line treated as search text. */
function parseAtomsQuery(source: string, currentPath: string | null): AtomFilter {
  const f: AtomFilter = {};
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const m = line.match(/^(\w+)\s*:\s*(.+)$/);
    if (m) {
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "kind") f.kind = val;
      else if (key === "relation") f.relation = val;
      else if (key === "search" || key === "text") f.query = val;
      else if (key === "source") f.source = val === "." ? currentPath ?? undefined : val;
    } else {
      f.query = line;
    }
  }
  return f;
}

export class AtomsWidget extends WidgetType {
  constructor(readonly source: string, readonly currentPath: string | null) {
    super();
  }
  eq(o: AtomsWidget) {
    return o.source === this.source && o.currentPath === this.currentPath;
  }
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-atoms onyx-rendered";
    el.innerHTML = `<div class="onyx-dv-empty">Loading atoms…</div>`;
    const filter = parseAtomsQuery(this.source, this.currentPath);
    api
      .getAtoms(filter)
      .then((atoms) => {
        if (atoms.length === 0) {
          el.innerHTML = `<div class="onyx-dv-empty">No matching atoms.</div>`;
          return;
        }
        el.innerHTML = atoms
          .map((a) => {
            const name = a.source_path.split("/").pop()?.replace(/\.md$/i, "") ?? a.source_path;
            const color = KIND_COLOR[a.kind] ?? "#888";
            return (
              `<div class="onyx-atom-row">` +
              `<span class="onyx-atom-kind" style="--ak:${color}">${escHtml(kindLabel(a.kind))}</span>` +
              `<span class="onyx-atom-text">${escHtml(a.text)}</span> ` +
              `<a class="tok-wikilink onyx-atom-src" data-wikilink="${escAttr(name)}">${escHtml(name)}</a>` +
              `</div>`
            );
          })
          .join("");
      })
      .catch(() => {
        el.innerHTML = `<div class="onyx-dv-error">Could not load atoms.</div>`;
      });
    return el;
  }
}

export class InlineDqlWidget extends WidgetType {
  constructor(
    readonly source: string,
    readonly version: number,
    readonly currentPath: string | null
  ) {
    super();
  }
  eq(o: InlineDqlWidget) {
    return o.source === this.source && o.version === this.version && o.currentPath === this.currentPath;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "onyx-inline-dql";
    span.innerHTML = cellHtml(runInline(this.source, getCachedPages(), this.currentPath));
    return span;
  }
}
