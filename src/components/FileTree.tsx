import { useEffect, useRef, useState } from "react";
import type { TreeNode } from "../lib/api";
import { useStore } from "../state/store";

// The path currently being dragged (module-level: survives across TreeItems).
let draggedPath: string | null = null;

function parentDir(path: string): string {
  const i = path.lastIndexOf("/");
  return i === -1 ? "" : path.slice(0, i);
}

/** Can `draggedPath` be dropped into folder `destDir`? */
function canDrop(destDir: string): boolean {
  const src = draggedPath;
  if (src == null) return false;
  if (destDir === src) return false; // onto itself
  if (destDir.startsWith(src + "/")) return false; // into own descendant
  if (parentDir(src) === destDir) return false; // already there
  return true;
}

function TreeItem({ node, depth }: { node: TreeNode; depth: number }) {
  const [open, setOpen] = useState(depth < 1);
  const [dragOver, setDragOver] = useState(false);
  const openNote = useStore((s) => s.openNote);
  const activeTab = useStore((s) => s.activeTab);
  const movePath = useStore((s) => s.movePath);
  const pad = { paddingLeft: `${depth * 12 + 8}px` };

  // For a folder the drop target is itself; for a file it's its parent folder.
  const destDir = node.is_dir ? node.path : parentDir(node.path);

  const onDragStart = (e: React.DragEvent) => {
    draggedPath = node.path;
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", node.path);
  };
  const onDragOver = (e: React.DragEvent) => {
    if (canDrop(destDir)) {
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      setDragOver(true);
    }
  };
  const onDrop = (e: React.DragEvent) => {
    if (!canDrop(destDir)) return;
    e.preventDefault();
    e.stopPropagation();
    setDragOver(false);
    const src = draggedPath;
    draggedPath = null;
    if (src) movePath(src, destDir);
  };

  const dropRing = dragOver
    ? "ring-1 ring-inset ring-[var(--onyx-accent)] bg-[var(--onyx-accent)]/10"
    : "";

  if (node.is_dir) {
    return (
      <div>
        <button
          draggable
          onDragStart={onDragStart}
          onDragEnter={onDragOver}
          onDragOver={onDragOver}
          onDragLeave={() => setDragOver(false)}
          onDrop={onDrop}
          style={pad}
          onClick={() => setOpen((o) => !o)}
          className={`flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-sm text-neutral-600 hover:bg-black/5 dark:text-neutral-300 dark:hover:bg-white/5 ${dropRing}`}
        >
          <span className="inline-block w-3 text-neutral-400">
            {open ? "▾" : "▸"}
          </span>
          <span className="truncate font-medium">{node.name}</span>
        </button>
        {open &&
          node.children.map((c) => (
            <TreeItem key={c.path} node={c} depth={depth + 1} />
          ))}
      </div>
    );
  }

  const isActive = activeTab === node.path;
  return (
    <button
      draggable
      onDragStart={onDragStart}
      onDragEnter={onDragOver}
      onDragOver={onDragOver}
      onDragLeave={() => setDragOver(false)}
      onDrop={onDrop}
      style={pad}
      onClick={() => openNote(node.path)}
      className={`flex w-full items-center gap-1 rounded py-1 pr-2 text-left text-sm hover:bg-black/5 dark:hover:bg-white/5 ${dropRing} ${
        isActive
          ? "bg-black/5 text-neutral-900 dark:bg-white/10 dark:text-white"
          : "text-neutral-600 dark:text-neutral-400"
      }`}
    >
      <span className="inline-block w-3" />
      <span className="truncate">{node.name.replace(/\.md$/i, "")}</span>
    </button>
  );
}

type CreateMode = "note" | "folder" | null;

export function FileTree() {
  const tree = useStore((s) => s.tree);
  const vault = useStore((s) => s.vault);
  const createAndOpen = useStore((s) => s.createAndOpen);
  const createFolder = useStore((s) => s.createFolder);
  const movePath = useStore((s) => s.movePath);

  const [mode, setMode] = useState<CreateMode>(null);
  const [name, setName] = useState("");
  const [rootOver, setRootOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (mode) inputRef.current?.focus();
  }, [mode]);

  const cancel = () => {
    setMode(null);
    setName("");
  };

  const confirm = async () => {
    const value = name.trim();
    if (!value) return cancel();
    if (mode === "note") await createAndOpen(value);
    else if (mode === "folder") await createFolder(value);
    cancel();
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      confirm();
    } else if (e.key === "Escape") {
      e.preventDefault();
      cancel();
    }
  };

  // Dropping on empty tree space moves to the vault root.
  const onRootDragOver = (e: React.DragEvent) => {
    if (canDrop("")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "move";
      setRootOver(true);
    }
  };
  const onRootDrop = (e: React.DragEvent) => {
    if (!canDrop("")) return;
    e.preventDefault();
    setRootOver(false);
    const src = draggedPath;
    draggedPath = null;
    if (src) movePath(src, "");
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-between px-3 py-2">
        <span className="truncate text-xs font-semibold uppercase tracking-wide text-neutral-500">
          {vault?.name ?? "No vault"}
        </span>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => setMode("note")}
            title="New note"
            className="rounded px-1.5 text-base leading-none text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            ＋
          </button>
          <button
            onClick={() => setMode("folder")}
            title="New folder"
            className="rounded px-1.5 text-base leading-none text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
          >
            🗀
          </button>
        </div>
      </div>

      {mode && (
        <div className="px-2 pb-1">
          <input
            ref={inputRef}
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={onKeyDown}
            onBlur={confirm}
            placeholder={
              mode === "note" ? "Note name (or Folder/Name)…" : "Folder name…"
            }
            className="w-full rounded border border-black/10 bg-white px-2 py-1 text-sm text-neutral-800 outline-none focus:border-[var(--onyx-accent)] dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100"
          />
        </div>
      )}

      <div
        onDragEnter={onRootDragOver}
        onDragOver={onRootDragOver}
        onDragLeave={() => setRootOver(false)}
        onDrop={onRootDrop}
        className={`flex-1 overflow-y-auto pb-4 ${
          rootOver ? "bg-[var(--onyx-accent)]/5" : ""
        }`}
      >
        {tree.length === 0 && !mode && (
          <p className="px-3 py-2 text-xs text-neutral-400">
            No markdown notes yet.
          </p>
        )}
        {tree.map((n) => (
          <TreeItem key={n.path} node={n} depth={0} />
        ))}
      </div>
    </div>
  );
}
