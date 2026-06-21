import { EditorView, WidgetType } from "@codemirror/view";
import { convertFileSrc } from "@tauri-apps/api/core";
import { renderMarkdown } from "./markdown";
import { getHost } from "./host";

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
  toDOM() {
    const el = document.createElement("div");
    el.className = "onyx-table onyx-rendered";
    el.innerHTML = renderMarkdown(this.source);
    return el;
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

let katexMod: Promise<typeof import("katex")> | null = null;
function loadKatex() {
  return (katexMod ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([m]) => m));
}
const mathCache = new Map<string, string>();

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

let mermaidMod: Promise<typeof import("mermaid")> | null = null;
function loadMermaid() {
  return (mermaidMod ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
      securityLevel: "strict",
    });
    return m;
  }));
}
const mermaidCache = new Map<string, string>();
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
