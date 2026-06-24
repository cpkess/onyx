// StreamWeaver: analyze a free-form note and propose "weaves" (links, tasks,
// tags, block distribution, new entities) that the user accepts in a sidebar.

import { api, noteName, type ChatMessage } from "../lib/api";
import { getActiveEditor } from "../editor/activeEditor";

export type Weave =
  | { kind: "link"; id: string; blockText: string; text: string; name: string; exists: boolean }
  | { kind: "task"; id: string; blockText: string; text: string; due: string | null }
  | { kind: "tag"; id: string; blockText: string; tag: string }
  | { kind: "distribute"; id: string; blockText: string; target: string; reason: string }
  | { kind: "create"; id: string; name: string };

const TAG_VOCAB = ["decision", "idea", "bookmark", "question", "todo"];

let seq = 0;
const wid = () => `w${Date.now().toString(36)}${seq++}`;
const blockId = () => `sw-${Date.now().toString(36)}${Math.floor(Math.random() * 1e3)}`;

/** Split note body into blocks (skip frontmatter), preserving original text. */
function segment(content: string): string[] {
  let body = content;
  if (body.startsWith("---\n")) {
    const e = body.indexOf("\n---");
    if (e !== -1) body = body.slice(e + 4);
  }
  return body
    .split(/\n[ \t]*\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

function extractJson(s: string): any {
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end <= start) return {};
  try {
    return JSON.parse(s.slice(start, end + 1));
  } catch {
    return {};
  }
}

/** Analyze a note → proposed weaves (calls the local LLM via ai_complete). */
export async function analyze(content: string): Promise<Weave[]> {
  const blocks = segment(content);
  if (blocks.length === 0) return [];
  const names = await api.getNoteNames().catch(() => []);

  const system =
    "You are StreamWeaver, organizing a stream-of-consciousness note. Respond with ONLY a JSON " +
    "object, no prose. Schema: {\"links\":[{\"block\":int,\"text\":string,\"name\":string}], " +
    "\"tasks\":[{\"block\":int,\"text\":string,\"due\":string|null}], " +
    "\"tags\":[{\"block\":int,\"tag\":string}], " +
    "\"distribute\":[{\"block\":int,\"target\":string,\"reason\":string}], " +
    "\"newEntities\":[{\"name\":string}]}. " +
    "links.text MUST be an exact substring of that block; links.name/target should be an existing " +
    `note title when one matches. tags.tag is one of: ${TAG_VOCAB.join(", ")}. ` +
    "due is ISO yyyy-mm-dd or null. Add people/projects with no matching note to newEntities. " +
    "Only propose high-confidence weaves.";
  const user =
    `Existing notes:\n${names.slice(0, 400).join(", ")}\n\nBlocks:\n` +
    blocks.map((b, i) => `[${i}]\n${b}`).join("\n\n");

  const messages: ChatMessage[] = [
    { role: "system", content: system },
    { role: "user", content: user },
  ];
  const raw = await api.aiComplete(messages);
  const parsed = extractJson(raw);
  const at = (i: unknown) => (typeof i === "number" && blocks[i] != null ? blocks[i] : "");

  const weaves: Weave[] = [];
  for (const l of parsed.links ?? []) {
    const bt = at(l.block);
    if (!bt || !l.name || !l.text) continue;
    // Skip if every occurrence of the text in the block is already a link.
    if (findUnlinked(bt, String(l.text)) === -1) continue;
    const resolved = await api.resolveLink(l.name).catch(() => null);
    weaves.push({ kind: "link", id: wid(), blockText: bt, text: String(l.text), name: String(l.name), exists: !!resolved });
  }
  for (const t of parsed.tasks ?? []) {
    const bt = at(t.block);
    if (!bt || !t.text) continue;
    weaves.push({ kind: "task", id: wid(), blockText: bt, text: String(t.text), due: t.due ? String(t.due) : null });
  }
  for (const tg of parsed.tags ?? []) {
    const bt = at(tg.block);
    if (!bt || !tg.tag) continue;
    weaves.push({ kind: "tag", id: wid(), blockText: bt, tag: String(tg.tag).replace(/^#/, "") });
  }
  for (const d of parsed.distribute ?? []) {
    const bt = at(d.block);
    if (!bt || !d.target) continue;
    weaves.push({ kind: "distribute", id: wid(), blockText: bt, target: String(d.target), reason: String(d.reason ?? "") });
  }
  const seen = new Set<string>();
  for (const e of parsed.newEntities ?? []) {
    if (!e.name) continue;
    const name = String(e.name);
    const resolved = await api.resolveLink(name).catch(() => null);
    if (resolved || seen.has(name.toLowerCase())) continue;
    seen.add(name.toLowerCase());
    weaves.push({ kind: "create", id: wid(), name });
  }
  return weaves;
}

/** Is `pos` inside an existing `[[ ... ]]` wikilink? */
function isInsideLink(doc: string, pos: number): boolean {
  const open = doc.lastIndexOf("[[", pos);
  const close = doc.lastIndexOf("]]", pos);
  return open !== -1 && open > close;
}

/** First occurrence of `needle` that is NOT already inside a wikilink, or -1. */
function findUnlinked(haystack: string, needle: string): number {
  let i = haystack.indexOf(needle);
  while (i !== -1) {
    const before = haystack.slice(i - 2, i);
    const after = haystack.slice(i + needle.length, i + needle.length + 2);
    if (before !== "[[" && after !== "]]" && !isInsideLink(haystack, i)) return i;
    i = haystack.indexOf(needle, i + 1);
  }
  return -1;
}

function blockRange(doc: string, blockText: string): { from: number; to: number } | null {
  let idx = doc.indexOf(blockText);
  if (idx === -1) {
    const first = blockText.split("\n")[0];
    idx = doc.indexOf(first);
    if (idx === -1) return null;
    return { from: idx, to: idx + first.length };
  }
  return { from: idx, to: idx + blockText.length };
}

/** Apply an accepted weave to the active note (and target notes). */
export async function applyWeave(w: Weave, currentPath: string | null): Promise<void> {
  if (w.kind === "create") {
    await api.createNoteWithContent(w.name, `# ${w.name}\n`).catch(() => {});
    return;
  }
  const view = getActiveEditor();
  if (!view) return;
  const doc = view.state.doc.toString();

  if (w.kind === "link") {
    // Only link an occurrence that isn't already inside a wikilink.
    const from = findUnlinked(doc, w.text);
    if (from === -1) return;
    const insert = w.name === w.text ? `[[${w.name}]]` : `[[${w.name}|${w.text}]]`;
    view.dispatch({ changes: { from, to: from + w.text.length, insert } });
    return;
  }

  const range = blockRange(doc, w.blockText);
  if (!range) return;

  if (w.kind === "tag") {
    view.dispatch({ changes: { from: range.to, insert: ` #${w.tag}` } });
  } else if (w.kind === "task") {
    const due = w.due ? ` 📅 ${w.due}` : "";
    view.dispatch({ changes: { from: range.to, insert: `\n- [ ] ${w.text}${due} ^${blockId()}` } });
  } else if (w.kind === "distribute") {
    const dailyName = currentPath ? noteName(currentPath) : "";
    if (!dailyName) return;
    // Headings can't carry block ids — transclude the heading section instead.
    const heading = w.blockText.split("\n")[0].trimStart().match(/^#{1,6}\s+(.*\S)\s*$/);
    if (heading) {
      await api.appendToNote(w.target, "Log", `![[${dailyName}#${heading[1]}]]`).catch(() => {});
      return;
    }
    // Otherwise ensure the source block ends with a ^block-id, then transclude.
    let id = "";
    const tail = w.blockText.match(/\^([\w-]+)\s*$/);
    if (tail) {
      id = tail[1];
    } else {
      id = blockId();
      view.dispatch({ changes: { from: range.to, insert: ` ^${id}` } });
    }
    await api.appendToNote(w.target, "Log", `![[${dailyName}#^${id}]]`).catch(() => {});
  }
}
