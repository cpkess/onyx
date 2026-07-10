import type { RegexRule } from "./core";
import { LinkedRefsWidget } from "./widgets";
import { noteName } from "../../lib/api";
import { blockRefsVersion } from "../../dataview/blockrefs";

/**
 * Append a collapsible "Linked References" section at the end of the page,
 * showing every block that references this note. Runs once per render (in
 * live/reading mode only — source mode returns before rules run).
 */
export const linkedRefsRule: RegexRule = (_text, _offset, ctx) => {
  const path = ctx.cb.currentPath;
  if (!path) return;
  ctx.widget(
    ctx.state.doc.length,
    new LinkedRefsWidget(noteName(path), blockRefsVersion()),
    1,
    true
  );
};

export const linkedRefsRegexRules: RegexRule[] = [linkedRefsRule];
