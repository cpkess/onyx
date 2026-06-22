import type { EditorMode } from "./editor/render/core";

export interface Settings {
  accent: string;
  fontSize: number;
  serif: boolean;
  readableWidth: boolean;
  defaultMode: EditorMode;
  attachmentsFolder: string;
  newNoteFolder: string;
  dailyFolder: string;
  dailyFormat: string;
  dailyTemplate: string; // path to a template note (optional)
  templatesFolder: string;
  hotkeys: Record<string, string>; // commandId -> combo override
}

export const defaultSettings: Settings = {
  accent: "#7c6cff",
  fontSize: 16,
  serif: false,
  readableWidth: true,
  defaultMode: "live",
  attachmentsFolder: "attachments",
  newNoteFolder: "",
  dailyFolder: "",
  dailyFormat: "YYYY-MM-DD",
  dailyTemplate: "",
  templatesFolder: "templates",
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
