import { api } from "./api";
import { useStore } from "../state/store";
import { getActiveEditorPath, replaceActiveDoc } from "../editor/activeEditor";

// Hierarchical Context Metadata (HCM): an `<!--ai … -->` block under a heading.
const HCM_RE = /<!--\s*ai\b[\s\S]*?-->/;

/** Does the note contain at least one HCM (`<!--ai … -->`) block? */
export function hasHcm(content: string): boolean {
  return HCM_RE.test(content);
}

/**
 * Regenerate every HCM-tagged section of the active page from its AI-context
 * instructions, and write the result back through the live editor.
 */
export async function composeActivePage(): Promise<void> {
  const { activeTab, refreshTree } = useStore.getState();
  if (!activeTab) throw new Error("No active note to compose.");
  const doc = await api.aiComposeSections(activeTab);
  if (!replaceActiveDoc(activeTab, doc.content)) {
    await api.writeNote(activeTab, doc.content);
    if (getActiveEditorPath() !== activeTab) useStore.getState().openNote(activeTab);
  }
  await refreshTree();
}
