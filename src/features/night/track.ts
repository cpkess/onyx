import { api } from "../../lib/api";

// Fire-and-forget activity logging for Night Shift. Cheap (one SQLite insert in
// Rust); errors are swallowed so tracking never affects the user's editing.
export function trackEvent(kind: string, entity?: string, metadata?: string) {
  api.recordEvent(kind, entity, metadata).catch(() => {});
}
