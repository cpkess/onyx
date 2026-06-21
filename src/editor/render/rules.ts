import type { NodeRule, RegexRule } from "./core";
import { inlineNodeRules, inlineRegexRules } from "./inline";
import { blockNodeRules } from "./blocks";
import { mediaRegexRules } from "./media";

export const nodeRules: NodeRule[] = [...blockNodeRules, ...inlineNodeRules];
// Media (images/embeds/frontmatter) runs first so it claims `![[...]]` ranges
// before the inline wikilink/footnote scans.
export const regexRules: RegexRule[] = [...mediaRegexRules, ...inlineRegexRules];
