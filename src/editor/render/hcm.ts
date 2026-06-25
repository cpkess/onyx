import type { RegexRule } from "./core";
import { HcmBadgeWidget } from "./widgets";

// Hierarchical Context Metadata: an `<!--ai … -->` HTML comment carrying a
// per-section AI instruction. Hidden in reading mode, shown as a small badge in
// live mode (raw source reveals when the cursor is on it), and left raw in
// source mode (the engine returns before rules run there).
const HCM_RE = /<!--\s*ai\b([\s\S]*?)-->/g;

const hcm: RegexRule = (text, offset, ctx) => {
  HCM_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HCM_RE.exec(text))) {
    // Expand to whole lines so the block decoration stays line-aligned.
    const doc = ctx.state.doc;
    const from = doc.lineAt(offset + m.index).from;
    const to = doc.lineAt(offset + m.index + m[0].length).to;

    const instruction = m[1].trim();
    const isReading = ctx.active.size === 0;
    if (isReading) {
      ctx.hide(from, to);
      continue;
    }
    if (ctx.rangeActive(from, to)) continue; // editing — show raw
    ctx.replace(from, to, new HcmBadgeWidget(instruction, from, to), true);
  }
};

export const hcmRegexRules: RegexRule[] = [hcm];
