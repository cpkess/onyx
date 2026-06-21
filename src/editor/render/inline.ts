import { Decoration } from "@codemirror/view";
import type { NodeRule, RegexRule } from "./core";
import { FootnoteRefWidget, MathWidget } from "./widgets";

// ---- Inline marker hiding (headings, bold/italic, strikethrough, code) ----

const MARKS_TO_HIDE = new Set([
  "HeaderMark",
  "EmphasisMark",
  "StrikethroughMark",
  "CodeMark",
]);

const markerHider: NodeRule = (node, ctx) => {
  if (!MARKS_TO_HIDE.has(node.name)) return;
  const lineNo = ctx.state.doc.lineAt(node.from).number;
  if (ctx.active.has(lineNo)) return;

  let end = node.to;
  if (node.name === "HeaderMark") {
    const line = ctx.state.doc.line(lineNo);
    while (end < line.to && ctx.state.doc.sliceString(end, end + 1) === " ") end++;
  }
  ctx.hide(node.from, end);
};

// ---- Wikilinks `[[...]]` and tags `#tag` ----

const WIKILINK_RE = /(?<!!)\[\[([^\]\n]+)\]\]/g;
const TAG_RE = /(^|[^\w&])#([A-Za-z0-9_][A-Za-z0-9_/-]*)/g;
const HIGHLIGHT_RE = /==([^=\n]+)==/g;

/** Bare target name from a `[[Target|alias]]` / `[[Target#heading]]` body. */
function targetName(body: string): string {
  return body.split("|")[0].split("#")[0].trim();
}

const inlineTokens: RegexRule = (text, offset, ctx) => {
  const linkSpans: [number, number][] = [];

  WIKILINK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = WIKILINK_RE.exec(text))) {
    const body = m[1];
    const name = targetName(body);
    const exists = ctx.names.has(name.toLowerCase());
    const cls = exists ? "tok-wikilink" : "tok-wikilink-missing";
    const anchor = body.includes("#") ? body.split("#")[1].split("|")[0].trim() : "";
    const attrs: Record<string, string> = { "data-wikilink": name };
    if (anchor) attrs["data-anchor"] = anchor;
    const linkMark = Decoration.mark({ class: cls, attributes: attrs });
    const matchStart = offset + m.index;
    const matchEnd = matchStart + m[0].length;
    const innerStart = matchStart + 2;
    const innerEnd = innerStart + body.length;
    linkSpans.push([matchStart, matchEnd]);

    if (ctx.lineActive(matchStart)) {
      ctx.mark(matchStart, matchEnd, linkMark);
    } else {
      ctx.hide(matchStart, innerStart);
      const pipe = body.indexOf("|");
      const hash = body.indexOf("#");
      if (pipe !== -1) {
        const aliasStart = innerStart + pipe + 1;
        ctx.hide(innerStart, aliasStart);
        ctx.mark(aliasStart, innerEnd, linkMark);
      } else if (hash !== -1) {
        const secStart = innerStart + hash;
        ctx.mark(innerStart, secStart, linkMark);
        ctx.hide(secStart, innerEnd);
      } else {
        ctx.mark(innerStart, innerEnd, linkMark);
      }
      ctx.hide(innerEnd, innerEnd + 2);
    }
  }

  TAG_RE.lastIndex = 0;
  while ((m = TAG_RE.exec(text))) {
    const lead = m[1].length;
    const tagStart = offset + m.index + lead;
    const tagEnd = tagStart + m[2].length + 1; // include '#'
    if (linkSpans.some(([s, e]) => tagStart < e && tagEnd > s)) continue;
    ctx.mark(tagStart, tagEnd, Decoration.mark({ class: "tok-tag" }));
  }

  HIGHLIGHT_RE.lastIndex = 0;
  while ((m = HIGHLIGHT_RE.exec(text))) {
    const matchStart = offset + m.index;
    const innerStart = matchStart + 2;
    const innerEnd = innerStart + m[1].length;
    if (linkSpans.some(([s, e]) => matchStart < e && innerEnd + 2 > s)) continue;
    ctx.mark(innerStart, innerEnd, Decoration.mark({ class: "tok-highlight" }));
    if (!ctx.lineActive(matchStart)) {
      ctx.hide(matchStart, innerStart);
      ctx.hide(innerEnd, innerEnd + 2);
    }
  }
};

const FOOTNOTE_RE = /\[\^([^\]\s]+)\]/g;

const footnotes: RegexRule = (text, offset, ctx) => {
  FOOTNOTE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FOOTNOTE_RE.exec(text))) {
    const matchStart = offset + m.index;
    const matchEnd = matchStart + m[0].length;
    const line = ctx.state.doc.lineAt(matchStart);
    // Skip footnote definitions ("[^1]: ..." at the start of a line).
    const isDef =
      line.from === matchStart &&
      ctx.state.doc.sliceString(matchEnd, matchEnd + 1) === ":";
    if (isDef) continue;
    if (ctx.lineActive(matchStart)) {
      ctx.mark(matchStart, matchEnd, Decoration.mark({ class: "tok-footnote-ref" }));
    } else {
      ctx.replace(matchStart, matchEnd, new FootnoteRefWidget(m[1]));
    }
  }
};

const MATH_BLOCK_RE = /\$\$([\s\S]+?)\$\$/g;
// Inline `$…$`: no space just inside the delimiters; avoid `$$` and currency.
const MATH_INLINE_RE = /(?<![\$\w])\$(?! )([^\$\n]+?)(?<! )\$(?!\$)/g;

const math: RegexRule = (text, offset, ctx) => {
  const blockSpans: [number, number][] = [];

  MATH_BLOCK_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MATH_BLOCK_RE.exec(text))) {
    const start = offset + m.index;
    const end = start + m[0].length;
    blockSpans.push([start, end]);
    if (ctx.rangeActive(start, end)) continue;
    ctx.replace(start, end, new MathWidget(m[1].trim(), true), true);
  }

  MATH_INLINE_RE.lastIndex = 0;
  while ((m = MATH_INLINE_RE.exec(text))) {
    const start = offset + m.index;
    const end = start + m[0].length;
    if (blockSpans.some(([s, e]) => start < e && end > s)) continue;
    if (ctx.lineActive(start)) continue; // show source while editing the line
    ctx.replace(start, end, new MathWidget(m[1].trim(), false));
  }
};

// Block ids (`^block-id` at end of a line) — hidden in reading mode like Obsidian.
const BLOCK_ID_RE = /(^|\s)(\^[A-Za-z0-9_-]+)[ \t]*$/gm;

const blockIds: RegexRule = (text, offset, ctx) => {
  BLOCK_ID_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = BLOCK_ID_RE.exec(text))) {
    const idStart = offset + m.index + m[1].length;
    const idEnd = idStart + m[2].length;
    if (ctx.lineActive(idStart)) continue;
    ctx.hide(idStart, idEnd);
  }
};

export const inlineNodeRules: NodeRule[] = [markerHider];
export const inlineRegexRules: RegexRule[] = [inlineTokens, footnotes, math, blockIds];



