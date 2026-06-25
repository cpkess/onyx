// Async post-render enhancement for rendered-markdown HTML: turns `[data-formula]`
// placeholders into KaTeX and ```mermaid code fences into diagrams. Shared by the
// editor widgets, the AI chat panel, hover previews, and note embeds. KaTeX and
// mermaid are lazy-loaded so they never weigh on first paint or the chat stream.

let katexMod: Promise<typeof import("katex")> | null = null;
export function loadKatex() {
  return (katexMod ??= Promise.all([
    import("katex"),
    import("katex/dist/katex.min.css"),
  ]).then(([m]) => m));
}
export const mathCache = new Map<string, string>();

let mermaidMod: Promise<typeof import("mermaid")> | null = null;
export function loadMermaid() {
  return (mermaidMod ??= import("mermaid").then((m) => {
    m.default.initialize({
      startOnLoad: false,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "default",
      securityLevel: "strict",
    });
    return m;
  }));
}
export const mermaidCache = new Map<string, string>();
let mermaidSeq = 0;

/** Render any KaTeX placeholders inside `el` (idempotent). */
function enhanceMath(el: HTMLElement) {
  const nodes = el.querySelectorAll<HTMLElement>("[data-formula]:not([data-enhanced])");
  if (nodes.length === 0) return;
  loadKatex().then(({ default: katex }) => {
    nodes.forEach((n) => {
      const formula = n.getAttribute("data-formula") ?? "";
      const display = n.classList.contains("onyx-math-block");
      const key = (display ? "D:" : "I:") + formula;
      let html = mathCache.get(key);
      if (html == null) {
        try {
          html = katex.renderToString(formula, { displayMode: display, throwOnError: false });
          mathCache.set(key, html);
        } catch {
          return; // leave the raw formula fallback in place
        }
      }
      n.innerHTML = html;
      n.setAttribute("data-enhanced", "1");
    });
  });
}

/** Render any ```mermaid fences inside `el` into diagrams (idempotent). */
function enhanceMermaid(el: HTMLElement) {
  const blocks = el.querySelectorAll<HTMLElement>("code.language-mermaid:not([data-enhanced])");
  if (blocks.length === 0) return;
  loadMermaid().then(async ({ default: mermaid }) => {
    for (const code of Array.from(blocks)) {
      code.setAttribute("data-enhanced", "1");
      const src = code.textContent ?? "";
      const target = code.closest("pre") ?? code;
      const holder = document.createElement("div");
      holder.className = "onyx-mermaid onyx-rendered";
      const cached = mermaidCache.get(src);
      if (cached) {
        holder.innerHTML = cached;
        target.replaceWith(holder);
        continue;
      }
      try {
        const { svg } = await mermaid.render(`onyx-mermaid-${mermaidSeq++}`, src);
        mermaidCache.set(src, svg);
        holder.innerHTML = svg;
      } catch (e) {
        holder.className = "onyx-mermaid-error";
        holder.textContent = `Mermaid error: ${e}`;
      }
      target.replaceWith(holder);
    }
  });
}

/** Apply all async enhancements to a container of rendered-markdown HTML. */
export function enhanceRendered(el: HTMLElement | null) {
  if (!el) return;
  enhanceMath(el);
  enhanceMermaid(el);
}
