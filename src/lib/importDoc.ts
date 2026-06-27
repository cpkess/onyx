import { open } from "@tauri-apps/plugin-dialog";
import { listen } from "@tauri-apps/api/event";
import { api } from "./api";

export const IMPORT_EXTENSIONS = ["pdf", "docx", "txt", "md"];

export interface ImportProgress {
  page: number;
  total: number;
}

/** Open a native file picker, then send the chosen file to the import pipeline. */
export async function pickAndImport(useLlm = true): Promise<string | null> {
  const path = await open({
    multiple: false,
    filters: [{ name: "Documents", extensions: IMPORT_EXTENSIONS }],
  });
  if (!path) return null;
  return api.importDocument(path as string, useLlm);
}

/** Ingest a dropped File by reading its bytes (no filesystem path available). */
export async function importFromFile(file: File, useLlm = true): Promise<string> {
  const buf = await file.arrayBuffer();
  const bytes = Array.from(new Uint8Array(buf));
  return api.importDocumentBytes(file.name, bytes, useLlm);
}

/** Is this filename a format we can ingest? */
export function isSupportedImport(name: string): boolean {
  const ext = name.split(".").pop()?.toLowerCase() ?? "";
  return IMPORT_EXTENSIONS.includes(ext);
}

/** Subscribe to per-page import progress. Returns an unlisten function. */
export function onImportProgress(cb: (p: ImportProgress) => void): () => void {
  const unlisten = listen<ImportProgress>("import:progress", (e) => cb(e.payload));
  return () => {
    unlisten.then((fn) => fn()).catch(() => {});
  };
}
