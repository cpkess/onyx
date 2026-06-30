import { Decoration } from "@codemirror/view";
import type { NodeRule, RenderCtx } from "./core";
import {
  AtomsWidget,
  BulletWidget,
  CalloutWidget,
  CheckboxWidget,
  CodeHeaderWidget,
  DataviewWidget,
  HrWidget,
  MermaidWidget,
  TableWidget,
} from "./widgets";
import { pagesVersion } from "../../dataview/pages";

const CALLOUT_RE = /^>\s*\[!(\w+)\][+-]?\s*(.*)$/;

function lastContentLine(ctx: RenderCtx, nodeTo: number) {
  const pos = Math.max(0, Math.min(nodeTo, ctx.state.doc.length) - 1);
  return ctx.state.doc.lineAt(pos);
}

const blockquoteRule: NodeRule = (node, ctx) => {
  if (node.name !== "Blockquote") return;
  const startLine = ctx.state.doc.lineAt(node.from);
  const endLine = lastContentLine(ctx, node.to);

  const callout = startLine.text.match(CALLOUT_RE);
  if (callout) {
    if (ctx.rangeActive(node.from, endLine.to)) return; // editing: show source
    const kind = callout[1].toLowerCase();
    const title = callout[2].trim();
    const bodyLines: string[] = [];
    for (let l = startLine.number + 1; l <= endLine.number; l++) {
      bodyLines.push(ctx.state.doc.line(l).text.replace(/^>\s?/, ""));
    }
    ctx.replace(startLine.from, endLine.to, new CalloutWidget(kind, title, bodyLines.join("\n")), true);
    return;
  }

  // Plain blockquote: keep a left border on every line (even while editing).
  for (let l = startLine.number; l <= endLine.number; l++) {
    ctx.line(ctx.state.doc.line(l).from, Decoration.line({ class: "cm-blockquote" }));
  }
};

const quoteMarkRule: NodeRule = (node, ctx) => {
  if (node.name !== "QuoteMark") return;
  if (ctx.lineActive(node.from)) return;
  let end = node.to;
  if (ctx.state.doc.sliceString(end, end + 1) === " ") end++;
  ctx.hide(node.from, end);
};

const hrRule: NodeRule = (node, ctx) => {
  if (node.name !== "HorizontalRule") return;
  const line = ctx.state.doc.lineAt(node.from);
  if (ctx.active.has(line.number)) return;
  ctx.replace(line.from, line.to, new HrWidget(), true);
};

const bulletRule: NodeRule = (node, ctx) => {
  if (node.name !== "ListMark") return;
  if (ctx.lineActive(node.from)) return;
  const txt = ctx.state.doc.sliceString(node.from, node.to);
  if (txt !== "-" && txt !== "*" && txt !== "+") return; // leave ordered markers
  const line = ctx.state.doc.lineAt(node.from);
  const after = ctx.state.doc.sliceString(node.to, line.to).trimStart();
  if (/^\[[ xX]\]/.test(after)) return; // task item — handled by checkbox
  ctx.replace(node.from, node.to, new BulletWidget());
};

const checkboxRule: NodeRule = (node, ctx) => {
  if (node.name !== "TaskMarker") return;
  if (ctx.lineActive(node.from)) return;
  const txt = ctx.state.doc.sliceString(node.from, node.to); // "[ ]" / "[x]"
  ctx.replace(node.from, node.to, new CheckboxWidget(/x/i.test(txt)));
};

const tableRule: NodeRule = (node, ctx) => {
  if (node.name !== "Table") return;
  // Tables are edited in-place via the WYSIWYG widget (raw markdown is shown in
  // Source mode), so render the widget regardless of cursor position.
  const startLine = ctx.state.doc.lineAt(node.from);
  const endLine = lastContentLine(ctx, node.to);
  const src = ctx.state.doc.sliceString(startLine.from, endLine.to);
  ctx.replace(startLine.from, endLine.to, new TableWidget(src), true);
};

const fencedCodeRule: NodeRule = (node, ctx) => {
  if (node.name !== "FencedCode") return;
  const startLine = ctx.state.doc.lineAt(node.from);
  const endLine = lastContentLine(ctx, node.to);
  const fence = startLine.text.match(/^\s*(?:`{3,}|~{3,})\s*([\w+-]*)/);
  const lang = fence ? fence[1] : "";
  if (lang === "mermaid" || lang === "dataview" || lang === "atoms") return; // handled by their own rules

  const bodyLines: string[] = [];
  for (let l = startLine.number + 1; l < endLine.number; l++) {
    bodyLines.push(ctx.state.doc.line(l).text);
  }
  for (let l = startLine.number; l <= endLine.number; l++) {
    ctx.line(ctx.state.doc.line(l).from, Decoration.line({ class: "cm-codeblock" }));
  }
  ctx.widget(startLine.from, new CodeHeaderWidget(lang, bodyLines.join("\n")), -1, true);
};

const mermaidRule: NodeRule = (node, ctx) => {
  if (node.name !== "FencedCode") return;
  const startLine = ctx.state.doc.lineAt(node.from);
  const endLine = lastContentLine(ctx, node.to);
  const fence = startLine.text.match(/^\s*(?:`{3,}|~{3,})\s*([\w+-]*)/);
  if (!fence || fence[1] !== "mermaid") return;
  if (ctx.rangeActive(node.from, endLine.to)) return;
  const code: string[] = [];
  for (let l = startLine.number + 1; l < endLine.number; l++) {
    code.push(ctx.state.doc.line(l).text);
  }
  ctx.replace(startLine.from, endLine.to, new MermaidWidget(code.join("\n")), true);
};

const dataviewRule: NodeRule = (node, ctx) => {
  if (node.name !== "FencedCode") return;
  const startLine = ctx.state.doc.lineAt(node.from);
  const endLine = lastContentLine(ctx, node.to);
  const fence = startLine.text.match(/^\s*(?:`{3,}|~{3,})\s*([\w+-]*)/);
  if (!fence || fence[1] !== "dataview") return;
  if (ctx.rangeActive(node.from, endLine.to)) return; // editing: show source
  const code: string[] = [];
  for (let l = startLine.number + 1; l < endLine.number; l++) {
    code.push(ctx.state.doc.line(l).text);
  }
  ctx.replace(
    startLine.from,
    endLine.to,
    new DataviewWidget(code.join("\n"), pagesVersion(), ctx.cb.currentPath ?? null),
    true
  );
};

const atomsRule: NodeRule = (node, ctx) => {
  if (node.name !== "FencedCode") return;
  const startLine = ctx.state.doc.lineAt(node.from);
  const endLine = lastContentLine(ctx, node.to);
  const fence = startLine.text.match(/^\s*(?:`{3,}|~{3,})\s*([\w+-]*)/);
  if (!fence || fence[1] !== "atoms") return;
  if (ctx.rangeActive(node.from, endLine.to)) return; // editing: show source
  const code: string[] = [];
  for (let l = startLine.number + 1; l < endLine.number; l++) {
    code.push(ctx.state.doc.line(l).text);
  }
  ctx.replace(
    startLine.from,
    endLine.to,
    new AtomsWidget(code.join("\n"), ctx.cb.currentPath ?? null),
    true
  );
};

export const blockNodeRules: NodeRule[] = [
  blockquoteRule,
  quoteMarkRule,
  hrRule,
  bulletRule,
  checkboxRule,
  tableRule,
  fencedCodeRule,
  mermaidRule,
  dataviewRule,
  atomsRule,
];
