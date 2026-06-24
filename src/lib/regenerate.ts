import { api } from "./api";
import { useStore } from "../state/store";
import { getActiveEditorPath, replaceActiveDoc } from "../editor/activeEditor";

export type GeneratedKind = "synthesis" | "subject";

/** Detect whether note content was produced by an Onyx generator. */
export function generatedKind(content: string): GeneratedKind | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---", 4);
  if (end === -1) return null;
  const m = content.slice(0, end).match(/^onyx_generated:\s*"?(synthesis|subject)"?/m);
  return m ? (m[1] as GeneratedKind) : null;
}

/**
 * Re-run the generator that produced the active page, pulling fresh information
 * from the vault, and write the result back through the live editor.
 */
export async function regenerateActivePage(): Promise<void> {
  const { activeTab, refreshTree } = useStore.getState();
  if (!activeTab) throw new Error("No active note to regenerate.");
  const doc = await api.aiRegenerate(activeTab);
  if (!replaceActiveDoc(activeTab, doc.content)) {
    // The page isn't the focused editor — persist directly and reopen it.
    await api.writeNote(activeTab, doc.content);
    if (getActiveEditorPath() !== activeTab) useStore.getState().openNote(activeTab);
  }
  await refreshTree();
}
