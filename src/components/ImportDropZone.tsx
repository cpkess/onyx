import { useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import {
  importFromFile,
  isSupportedImport,
  onImportProgress,
  type ImportProgress,
} from "../lib/importDoc";

// A full-window overlay that lets the user drag a document file (PDF/DOCX/TXT)
// onto Onyx to ingest it. Works with `dragDropEnabled:false` (HTML5 DnD), so we
// read the dropped File's bytes rather than its path.
export function ImportDropZone() {
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<ImportProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Counter to handle nested dragenter/dragleave without flicker.
  const depth = useRef(0);

  const refreshTree = useStore((s) => s.refreshTree);
  const openNote = useStore((s) => s.openNote);

  useEffect(() => onImportProgress(setProgress), []);

  useEffect(() => {
    const hasFiles = (e: DragEvent) =>
      Array.from(e.dataTransfer?.types ?? []).includes("Files");

    const onDragEnter = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current += 1;
      setDragging(true);
    };
    const onDragOver = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault(); // required to allow a drop (and stop webview navigation)
      if (e.dataTransfer) e.dataTransfer.dropEffect = "copy";
    };
    const onDragLeave = (e: DragEvent) => {
      if (!hasFiles(e)) return;
      depth.current = Math.max(0, depth.current - 1);
      if (depth.current === 0) setDragging(false);
    };
    const onDrop = async (e: DragEvent) => {
      if (!hasFiles(e)) return;
      e.preventDefault();
      depth.current = 0;
      setDragging(false);
      const files = Array.from(e.dataTransfer?.files ?? []);
      const file = files.find((f) => isSupportedImport(f.name));
      if (!file) {
        if (files.length) setError("Unsupported file type. Use PDF, DOCX, or TXT.");
        return;
      }
      setError(null);
      setBusy(true);
      setProgress(null);
      try {
        const rel = await importFromFile(file);
        await refreshTree();
        openNote(rel);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        setProgress(null);
      }
    };

    window.addEventListener("dragenter", onDragEnter);
    window.addEventListener("dragover", onDragOver);
    window.addEventListener("dragleave", onDragLeave);
    window.addEventListener("drop", onDrop);
    return () => {
      window.removeEventListener("dragenter", onDragEnter);
      window.removeEventListener("dragover", onDragOver);
      window.removeEventListener("dragleave", onDragLeave);
      window.removeEventListener("drop", onDrop);
    };
  }, [refreshTree, openNote]);

  if (!dragging && !busy && !error) return null;

  return (
    <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center">
      {(dragging || busy) && (
        <div className="absolute inset-0 bg-[var(--onyx-accent)]/10 backdrop-blur-[1px]" />
      )}
      <div className="relative flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-[var(--onyx-accent)] bg-white/90 px-8 py-6 text-center shadow-lg dark:bg-neutral-800/90">
        {busy ? (
          <>
            <span className="text-2xl">⏳</span>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              {progress
                ? `Importing… page ${progress.page} / ${progress.total}`
                : "Importing…"}
            </span>
          </>
        ) : error ? (
          <>
            <span className="text-2xl">⚠️</span>
            <span className="pointer-events-auto max-w-xs text-sm text-red-600 dark:text-red-400">
              {error}
            </span>
            <button
              onClick={() => setError(null)}
              className="pointer-events-auto rounded bg-black/5 px-2 py-0.5 text-xs text-neutral-600 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-300"
            >
              Dismiss
            </button>
          </>
        ) : (
          <>
            <span className="text-2xl">📥</span>
            <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
              Drop to import (PDF, DOCX, TXT)
            </span>
          </>
        )}
      </div>
    </div>
  );
}
