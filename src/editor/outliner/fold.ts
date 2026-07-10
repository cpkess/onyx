import { foldService } from "@codemirror/language";
import { isListLine, outlinerFacet, subtreeEnd } from "./blockTree";

/**
 * Fold a list item down to (but not including) the end of its subtree, so a
 * bullet with children can be collapsed. Complements the heading fold service;
 * both are consulted by the shared foldGutter / foldKeymap already mounted.
 */
export const listFold = foldService.of((state, from) => {
  if (!state.facet(outlinerFacet)) return null;
  const line = state.doc.lineAt(from);
  if (!isListLine(line.text)) return null;
  const endLine = subtreeEnd(state, line.number);
  if (endLine <= line.number) return null; // no children to fold
  const to = state.doc.line(endLine).to;
  return to > line.to ? { from: line.to, to } : null;
});
