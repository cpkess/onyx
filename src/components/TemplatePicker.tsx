import { api, noteName, type TreeNode } from "../lib/api";
import { useStore } from "../state/store";
import { insertText } from "../editor/activeEditor";
import { substituteTemplate } from "../settings";

function flatten(nodes: TreeNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.is_dir) flatten(n.children, out);
    else out.push(n.path);
  }
  return out;
}

export function TemplatePicker() {
  const open = useStore((s) => s.templatePickerOpen);
  const setOpen = useStore((s) => s.setTemplatePickerOpen);
  const tree = useStore((s) => s.tree);
  const folder = useStore((s) => s.settings.templatesFolder);
  const activeTab = useStore((s) => s.activeTab);

  if (!open) return null;
  const prefix = folder.trim().replace(/\/+$/, "") + "/";
  const templates = flatten(tree).filter((p) => p.startsWith(prefix));

  const pick = async (p: string) => {
    const content = await api.readNote(p).catch(() => "");
    insertText(substituteTemplate(content, activeTab ? noteName(activeTab) : ""));
    setOpen(false);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[14vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[28rem] max-w-[90vw] overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="border-b border-black/10 px-4 py-2 text-sm font-medium text-neutral-700 dark:border-white/10 dark:text-neutral-200">
          Insert template
        </div>
        <div className="max-h-[50vh] overflow-y-auto">
          {!activeTab && (
            <div className="px-4 py-4 text-sm text-neutral-400">Open a note first.</div>
          )}
          {activeTab && templates.length === 0 && (
            <div className="px-4 py-4 text-sm text-neutral-400">
              No templates in “{folder}/”. Create notes there or change the folder in Settings.
            </div>
          )}
          {activeTab &&
            templates.map((p) => (
              <button
                key={p}
                onClick={() => pick(p)}
                className="block w-full px-4 py-2 text-left text-sm text-neutral-700 hover:bg-black/5 dark:text-neutral-200 dark:hover:bg-white/10"
              >
                {noteName(p)}
              </button>
            ))}
        </div>
      </div>
    </div>
  );
}
