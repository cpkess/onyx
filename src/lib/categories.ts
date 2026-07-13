import { substituteTemplate, type Category } from "../settings";
import type { Page } from "./api";

/** Escape a string for literal use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The category whose (non-empty) trigger char equals `char`, if any. */
export function categoryByTrigger(char: string, cats: Category[]): Category | undefined {
  return cats.find((c) => c.trigger && c.trigger === char);
}

export function categoryById(id: string, cats: Category[]): Category | undefined {
  return cats.find((c) => c.id === id);
}

/** Does a page belong to a category — by its folder (incl. nested) or `type:` field? */
export function pageInCategory(page: Page, cat: Category): boolean {
  const folder = (cat.folder ?? "").trim().replace(/\/+$/, "");
  if (folder && (page.folder === folder || page.folder.startsWith(folder + "/"))) {
    return true;
  }
  const t = (page.fields as Record<string, unknown> | undefined)?.type;
  if (Array.isArray(t)) return t.map(String).some((x) => x.toLowerCase() === cat.id);
  return String(t ?? "").toLowerCase() === cat.id;
}

/** Candidate note names (file stems) in a category, for typed-link autocomplete. */
export function notesInCategory(pages: Page[], cat: Category): string[] {
  return pages.filter((p) => pageInCategory(p, cat)).map((p) => p.name);
}

/** Body for a new categorized note: `type:` (+ optional `parent:`) frontmatter,
 *  then the template (with {{title}} etc. substituted) or a default H1. */
export function newCategoryNoteBody(
  cat: Category,
  name: string,
  templateText: string,
  parent?: string
): string {
  const fm =
    `---\ntype: ${cat.id}\n` +
    (parent ? `parent: "[[${parent}]]"\n` : "") +
    `---\n\n`;
  const body = templateText ? substituteTemplate(templateText, name) : `# ${name}\n`;
  return fm + body;
}
