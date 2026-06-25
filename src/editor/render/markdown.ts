import MarkdownIt from "markdown-it";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import DOMPurify from "dompurify";

// Shared markdown renderer for widget inner content (callouts, embeds, tables),
// hover previews, and the AI chat panel. Base markdown-it (tables, strikethrough,
// etc.) plus a few rules so chat/embeds match the reading view: ==highlight==,
// math placeholders ($…$ / $$…$$, upgraded to KaTeX by enhance.ts), and task lists.
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;
const DOLLAR = 0x24;
const EQUALS = 0x3d;

function escapeAttr(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** `==highlight==` → <mark class="tok-highlight">…</mark>. Skips code spans. */
function markRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  if (state.src.charCodeAt(start) !== EQUALS || state.src.charCodeAt(start + 1) !== EQUALS)
    return false;
  let pos = start + 2;
  let found = -1;
  while (pos < max - 1) {
    if (state.src.charCodeAt(pos) === EQUALS && state.src.charCodeAt(pos + 1) === EQUALS) {
      found = pos;
      break;
    }
    pos++;
  }
  if (found === -1 || found === start + 2) return false;
  if (!silent) {
    const open = state.push("mark_open", "mark", 1);
    open.attrSet("class", "tok-highlight");
    const text = state.push("text", "", 0);
    text.content = state.src.slice(start + 2, found);
    state.push("mark_close", "mark", -1);
  }
  state.pos = found + 2;
  return true;
}

/** Inline `$…$` and block `$$…$$` math → a placeholder enhance.ts upgrades to KaTeX. */
function mathRule(state: StateInline, silent: boolean): boolean {
  const start = state.pos;
  const max = state.posMax;
  if (state.src.charCodeAt(start) !== DOLLAR) return false;
  const display = state.src.charCodeAt(start + 1) === DOLLAR;
  const markerLen = display ? 2 : 1;
  let pos = start + markerLen;
  if (!display) {
    // Avoid matching currency: opener not followed by space/newline/digit.
    const nc = state.src.charCodeAt(pos);
    if (nc === 0x20 || nc === 0x0a || (nc >= 0x30 && nc <= 0x39) || Number.isNaN(nc)) return false;
  }
  let found = -1;
  while (pos < max) {
    const c = state.src.charCodeAt(pos);
    if (c === 0x5c) {
      pos += 2; // skip escaped char
      continue;
    }
    if (c === DOLLAR) {
      if (display) {
        if (state.src.charCodeAt(pos + 1) === DOLLAR) {
          found = pos;
          break;
        }
      } else if (state.src.charCodeAt(pos - 1) !== 0x20) {
        found = pos;
        break;
      }
    }
    pos++;
  }
  if (found === -1) return false;
  const content = state.src.slice(start + markerLen, found);
  if (!content.trim()) return false;
  if (!silent) {
    const token = state.push("math", "", 0);
    token.content = content;
    token.meta = { display };
  }
  state.pos = found + markerLen;
  return true;
}

md.inline.ruler.before("emphasis", "mark", markRule);
md.inline.ruler.before("escape", "math", mathRule);
md.renderer.rules.math = (tokens, idx) => {
  const { content } = tokens[idx];
  const display = tokens[idx].meta?.display;
  const cls = display ? "onyx-math onyx-math-block" : "onyx-math";
  const raw = display ? `$$${escapeHtml(content)}$$` : `$${escapeHtml(content)}$`;
  // Raw formula stays visible as a fallback until enhance.ts renders KaTeX.
  return `<span class="${cls}" data-formula="${escapeAttr(content)}">${raw}</span>`;
};

/** Turn `- [ ]` / `- [x]` list items into read-only checkbox items. */
function taskLists(html: string): string {
  return html.replace(
    /<li>(\s*<p>)?\s*\[([ xX])\]\s+/g,
    (_m, p: string | undefined, mark: string) =>
      `<li class="onyx-task">${p ?? ""}<input type="checkbox" disabled${
        mark === " " ? "" : " checked"
      }> `
  );
}

/** Turn `[[Target|alias]]` into a clickable anchor reusing the editor click handler. */
function linkifyWikilinks(html: string): string {
  return html.replace(WIKILINK_RE, (_full, body: string) => {
    const target = body.split("|")[0];
    const name = target.split("#")[0].trim();
    const anchor = target.includes("#") ? target.split("#")[1].trim() : "";
    const label = (body.includes("|") ? body.split("|")[1] : body).trim();
    const anchorAttr = anchor ? ` data-anchor="${escapeAttr(anchor)}"` : "";
    return `<a class="tok-wikilink" data-wikilink="${escapeAttr(name)}"${anchorAttr}>${escapeHtml(
      label
    )}</a>`;
  });
}

const PURIFY_OPTS = {
  ADD_TAGS: ["mark", "input"],
  ADD_ATTR: ["data-wikilink", "data-anchor", "target", "data-formula", "type", "checked", "disabled"],
};

/** Render block markdown to sanitized HTML (with clickable wikilinks). */
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(taskLists(linkifyWikilinks(md.render(src))), PURIFY_OPTS);
}

/** Render a single line/paragraph of markdown without the wrapping <p>. */
export function renderInline(src: string): string {
  return DOMPurify.sanitize(linkifyWikilinks(md.renderInline(src)), PURIFY_OPTS);
}
