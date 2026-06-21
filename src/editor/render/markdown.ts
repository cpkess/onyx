import MarkdownIt from "markdown-it";
import DOMPurify from "dompurify";

// Shared markdown renderer for widget inner content (callouts, embeds, tables).
const md = new MarkdownIt({ html: false, linkify: true, breaks: false });

const WIKILINK_RE = /\[\[([^\]\n]+)\]\]/g;

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/</g, "&lt;");
}
function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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

const PURIFY_OPTS = { ADD_ATTR: ["data-wikilink", "data-anchor", "target"] };

/** Render block markdown to sanitized HTML (with clickable wikilinks). */
export function renderMarkdown(src: string): string {
  return DOMPurify.sanitize(linkifyWikilinks(md.render(src)), PURIFY_OPTS);
}

/** Render a single line/paragraph of markdown without the wrapping <p>. */
export function renderInline(src: string): string {
  return DOMPurify.sanitize(linkifyWikilinks(md.renderInline(src)), PURIFY_OPTS);
}
