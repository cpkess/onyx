import type { NodeRule, RegexRule } from "./core";
import { inlineNodeRules, inlineRegexRules } from "./inline";
import { blockNodeRules } from "./blocks";
import { mediaRegexRules } from "./media";
import { hcmRegexRules } from "./hcm";

export const nodeRules: NodeRule[] = [...blockNodeRules, ...inlineNodeRules];
// Media (images/embeds/frontmatter) runs first so it claims `![[...]]` ranges
// before the inline scans; HCM claims its `<!--ai-->` block next.
export const regexRules: RegexRule[] = [
  ...mediaRegexRules,
  ...hcmRegexRules,
  ...inlineRegexRules,
];
