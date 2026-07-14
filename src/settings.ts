import type { EditorMode } from "./editor/render/core";

/** A note category (People, Projects, …) — a folder + optional typed-link trigger. */
export interface Category {
  id: string; // stable key, also the `type:` frontmatter value (e.g. "person")
  name: string; // display label (e.g. "Person")
  folder: string; // default folder for new notes of this category
  trigger: string; // single char that autocompletes this category (e.g. "@"); "" = none
  template: string; // optional template note path
}

export interface Settings {
  accent: string;
  fontSize: number;
  serif: boolean;
  readableWidth: boolean;
  showFormattingToolbar: boolean;
  defaultMode: EditorMode;
  attachmentsFolder: string;
  newNoteFolder: string;
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string; // path to a template note (optional)
  weekStart: 0 | 1; // calendar week start: 0 = Sunday, 1 = Monday
  templatesFolder: string;
  outliner: boolean; // Logseq-style block outliner keys (Tab/Enter/fold)
  spellcheck: boolean; // native (macOS) spell check squiggles in the editor
  categories: Category[]; // typed note categories (People, Projects, …)
  hotkeys: Record<string, string>; // commandId -> combo override
}

export const defaultSettings: Settings = {
  accent: "#7c6cff",
  fontSize: 16,
  serif: false,
  readableWidth: true,
  showFormattingToolbar: true,
  defaultMode: "live",
  attachmentsFolder: "attachments",
  newNoteFolder: "",
  dailyFolder: "",
  dailyFormat: "YYYY-MM-DD",
  dailyTemplate: "",
  weekStart: 0,
  templatesFolder: "templates",
  outliner: true,
  spellcheck: true,
  categories: [
    { id: "person", name: "Person", folder: "People", trigger: "@", template: "" },
    { id: "project", name: "Project", folder: "Projects", trigger: "+", template: "" },
  ],
  hotkeys: {},
};

const SANS =
  "ui-sans-serif, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";
const SERIF = "Georgia, 'Iowan Old Style', 'Times New Roman', serif";

/** Apply visual settings to CSS variables consumed by styles.css. */
export function applyAppearance(s: Settings) {
  const r = document.documentElement.style;
  r.setProperty("--onyx-accent", s.accent);
  r.setProperty("--onyx-font-size", `${s.fontSize}px`);
  r.setProperty("--onyx-measure", s.readableWidth ? "46rem" : "100%");
  r.setProperty("--onyx-font", s.serif ? SERIF : SANS);
}

/** Minimal moment-style date formatter (YYYY MM DD HH mm ss). */
export function formatDate(fmt: string, d = new Date()): string {
  const p = (n: number, l = 2) => String(n).padStart(l, "0");
  return fmt
    .replace(/YYYY/g, String(d.getFullYear()))
    .replace(/MM/g, p(d.getMonth() + 1))
    .replace(/DD/g, p(d.getDate()))
    .replace(/HH/g, p(d.getHours()))
    .replace(/mm/g, p(d.getMinutes()))
    .replace(/ss/g, p(d.getSeconds()));
}

/** Substitute {{date}} / {{time}} / {{title}} in template text. */
export function substituteTemplate(text: string, title: string): string {
  const now = new Date();
  return text
    .replace(/\{\{date\}\}/g, formatDate("YYYY-MM-DD", now))
    .replace(/\{\{time\}\}/g, formatDate("HH:mm", now))
    .replace(/\{\{title\}\}/g, title);
}
