// Pure, immutable helpers for the editor pane layout (a flat row of panes,
// each with its own tabs + active tab). Kept separate from the store so the
// logic is easy to reason about and test.

export interface Pane {
  id: string;
  tabs: string[];
  activeTab: string | null;
}

export interface Workspace {
  panes: Pane[];
  activePaneId: string;
}

export function newId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export function emptyWorkspace(): Workspace {
  const pane: Pane = { id: newId(), tabs: [], activeTab: null };
  return { panes: [pane], activePaneId: pane.id };
}

export function activePane(ws: Workspace): Pane {
  return ws.panes.find((p) => p.id === ws.activePaneId) ?? ws.panes[0];
}

function mapPane(ws: Workspace, id: string, fn: (p: Pane) => Pane): Workspace {
  return { ...ws, panes: ws.panes.map((p) => (p.id === id ? fn(p) : p)) };
}

export function openInPane(ws: Workspace, paneId: string, path: string): Workspace {
  // One file per pane: opening a note replaces whatever the pane was showing.
  return {
    ...mapPane(ws, paneId, (p) => ({ ...p, tabs: [path], activeTab: path })),
    activePaneId: paneId,
  };
}

/**
 * Open `path` in the pane to the right of the active pane, reusing it if one
 * exists (keeps a tidy two-panel layout) or creating one if it doesn't. Focus
 * stays on the reference pane so repeated use doesn't spawn extra panels.
 */
export function openToRight(ws: Workspace, path: string): Workspace {
  const refIdx = Math.max(0, ws.panes.findIndex((p) => p.id === ws.activePaneId));
  const right = ws.panes[refIdx + 1];
  if (right) {
    const next = openInPane(ws, right.id, path);
    return { ...next, activePaneId: ws.activePaneId };
  }
  const fresh: Pane = { id: newId(), tabs: [path], activeTab: path };
  const panes = [...ws.panes];
  panes.splice(refIdx + 1, 0, fresh);
  return { panes, activePaneId: ws.activePaneId };
}

export function setActiveInPane(ws: Workspace, paneId: string, path: string): Workspace {
  return { ...mapPane(ws, paneId, (p) => ({ ...p, activeTab: path })), activePaneId: paneId };
}

export function closeInPane(ws: Workspace, paneId: string, path: string): Workspace {
  const pane = ws.panes.find((p) => p.id === paneId);
  if (!pane) return ws;
  const idx = pane.tabs.indexOf(path);
  const tabs = pane.tabs.filter((t) => t !== path);
  const activeTab =
    pane.activeTab === path ? tabs[Math.min(idx, tabs.length - 1)] ?? null : pane.activeTab;

  // Remove the pane entirely if it emptied and it isn't the last pane.
  if (tabs.length === 0 && ws.panes.length > 1) {
    const panes = ws.panes.filter((p) => p.id !== paneId);
    const activePaneId = ws.activePaneId === paneId ? panes[0].id : ws.activePaneId;
    return { panes, activePaneId };
  }
  return mapPane(ws, paneId, (p) => ({ ...p, tabs, activeTab }));
}

export function splitPane(ws: Workspace, paneId: string): Workspace {
  const pane = ws.panes.find((p) => p.id === paneId) ?? activePane(ws);
  const fresh: Pane = {
    id: newId(),
    tabs: pane.activeTab ? [pane.activeTab] : [],
    activeTab: pane.activeTab,
  };
  const at = ws.panes.findIndex((p) => p.id === pane.id);
  const panes = [...ws.panes];
  panes.splice(at + 1, 0, fresh);
  return { panes, activePaneId: fresh.id };
}

export function closePane(ws: Workspace, paneId: string): Workspace {
  if (ws.panes.length <= 1) return ws;
  const panes = ws.panes.filter((p) => p.id !== paneId);
  const activePaneId = ws.activePaneId === paneId ? panes[0].id : ws.activePaneId;
  return { panes, activePaneId };
}

export function moveTab(
  ws: Workspace,
  path: string,
  fromPaneId: string,
  toPaneId: string
): Workspace {
  if (fromPaneId === toPaneId) return ws;
  const after = closeInPane(ws, fromPaneId, path);
  // closeInPane may have removed the source pane; the target id is unaffected.
  return openInPane(after, toPaneId, path);
}

/** Apply a path-remapping function (rename/move) to every tab in every pane. */
export function remapPaths(ws: Workspace, fn: (p: string) => string): Workspace {
  return {
    ...ws,
    panes: ws.panes.map((p) => {
      const tabs = Array.from(new Set(p.tabs.map(fn)));
      return { ...p, tabs, activeTab: p.activeTab ? fn(p.activeTab) : null };
    }),
  };
}

/** Remove a path (deleted note) from every pane. */
export function removePathEverywhere(ws: Workspace, path: string): Workspace {
  let out = ws;
  for (const p of ws.panes) {
    if (p.tabs.includes(path)) out = closeInPane(out, p.id, path);
  }
  return out;
}

/** Close every tab under a deleted folder (`prefix` itself or `prefix/...`). */
export function removeSubtreeEverywhere(ws: Workspace, prefix: string): Workspace {
  let out = ws;
  const match = (t: string) => t === prefix || t.startsWith(prefix + "/");
  for (const p of ws.panes) {
    for (const t of p.tabs.filter(match)) out = closeInPane(out, p.id, t);
  }
  return out;
}
