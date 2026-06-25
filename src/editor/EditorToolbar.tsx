import type { ReactNode } from "react";
import { useStore } from "../state/store";
import {
  wrapSelection,
  toggleLinePrefix,
  cycleHeading,
  insertSnippet,
  insertHcmBlock,
} from "./activeEditor";

const BTN =
  "rounded px-1.5 py-0.5 text-xs text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10";
const DIV = "mx-1 h-4 w-px shrink-0 bg-black/10 dark:bg-white/10";

/** A small button that acts on the editor without stealing its focus. */
function Tool({
  label,
  title,
  onRun,
  className = "",
}: {
  label: ReactNode;
  title: string;
  onRun: () => void;
  className?: string;
}) {
  return (
    <button
      title={title}
      onMouseDown={(e) => e.preventDefault()} // keep editor focus
      onClick={onRun}
      className={`${BTN} ${className}`}
    >
      {label}
    </button>
  );
}

/**
 * Hideable per-note formatting + advanced-tagging toolbar. Applies plain
 * markdown to the active editor. Hidden in Reading mode and when the
 * `showFormattingToolbar` setting is off.
 */
export function EditorToolbar({ path }: { path: string }) {
  const mode = useStore((s) => s.noteModes[path] ?? s.settings.defaultMode);
  const show = useStore((s) => s.settings.showFormattingToolbar);
  if (mode === "reading" || !show) return null;

  return (
    <div className="flex shrink-0 flex-wrap items-center gap-0.5 px-7 pb-1.5">
      {/* Format */}
      <Tool label={<b>B</b>} title="Bold (⌘B)" onRun={() => wrapSelection("**")} />
      <Tool label={<i>I</i>} title="Italic (⌘I)" onRun={() => wrapSelection("*")} />
      <Tool label={<s>S</s>} title="Strikethrough" onRun={() => wrapSelection("~~")} />
      <Tool label={<>{"</>"}</>} title="Inline code" onRun={() => wrapSelection("`")} />
      <Tool label={<mark className="bg-transparent">H</mark>} title="Highlight" onRun={() => wrapSelection("==")} />

      <span className={DIV} />

      {/* Structure */}
      <Tool label="H1" title="Heading 1" onRun={() => cycleHeading(1)} />
      <Tool label="H2" title="Heading 2" onRun={() => cycleHeading(2)} />
      <Tool label="H3" title="Heading 3" onRun={() => cycleHeading(3)} />
      <Tool label="•" title="Bullet list" onRun={() => toggleLinePrefix("- ")} />
      <Tool label="1." title="Numbered list" onRun={() => toggleLinePrefix("1. ")} />
      <Tool label="☐" title="Task" onRun={() => toggleLinePrefix("- [ ] ")} />
      <Tool label="“" title="Quote" onRun={() => toggleLinePrefix("> ")} />

      <span className={DIV} />

      {/* Insert */}
      <Tool label="🔗" title="Wikilink [[ ]]" onRun={() => insertSnippet("[[]]", 2)} />
      <Tool label="❝!" title="Callout" onRun={() => insertSnippet("> [!note] \n> ")} />

      <span className={DIV} />

      {/* Advanced tagging */}
      <Tool
        label="✨ AI"
        title="Insert AI context block (HCM)"
        onRun={() => insertHcmBlock()}
        className="text-[var(--onyx-accent)]"
      />
      <Tool label="#" title="Insert tag" onRun={() => insertSnippet("#")} />
    </div>
  );
}
