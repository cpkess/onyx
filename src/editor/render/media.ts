import type { RegexRule } from "./core";
import { EmbedWidget, ImageWidget, PropertiesWidget } from "./widgets";

const MD_IMAGE_RE = /!\[([^\]]*)\]\(([^)\s]+)(?:\s+"[^"]*")?\)/g;
const EMBED_RE = /!\[\[([^\]\n]+)\]\]/g;
const IMG_EXT = /\.(png|jpe?g|gif|svg|webp|bmp|avif)$/i;

/** Inline images `![alt](url)` and embeds/transclusion `![[...]]`. */
const imagesAndEmbeds: RegexRule = (text, offset, ctx) => {
  MD_IMAGE_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = MD_IMAGE_RE.exec(text))) {
    const start = offset + m.index;
    const end = start + m[0].length;
    if (ctx.lineActive(start)) continue;
    ctx.replace(start, end, new ImageWidget(m[2], m[1], ""));
  }

  EMBED_RE.lastIndex = 0;
  while ((m = EMBED_RE.exec(text))) {
    const start = offset + m.index;
    const end = start + m[0].length;
    const body = m[1];
    const [targetPart, width] = body.split("|");
    const target = targetPart.trim();
    if (IMG_EXT.test(target)) {
      if (ctx.lineActive(start)) continue;
      ctx.replace(start, end, new ImageWidget(target, target, (width ?? "").trim()));
    } else {
      if (ctx.rangeActive(start, end)) continue;
      const [name, anchor] = target.split("#");
      ctx.replace(start, end, new EmbedWidget(name.trim(), (anchor ?? "").trim()), true);
    }
  }
};

/** YAML frontmatter at the very start of the doc → a Properties table. */
const frontmatter: RegexRule = (text, offset, ctx) => {
  if (offset !== 0) return;
  const m = text.match(/^---\n([\s\S]*?)\n---/);
  if (!m) return;
  const end = m[0].length;
  if (ctx.rangeActive(0, end)) return;
  const entries: [string, string][] = m[1]
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => {
      const i = l.indexOf(":");
      return i === -1
        ? ([l.trim(), ""] as [string, string])
        : ([l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]);
    });
  ctx.replace(0, end, new PropertiesWidget(entries), true);
};

export const mediaRegexRules: RegexRule[] = [imagesAndEmbeds, frontmatter];
