import { useEffect, useRef, useState } from "react";
import { api } from "../lib/api";
import { renderMarkdown } from "../editor/render/markdown";

interface Preview {
  x: number;
  y: number;
  html: string;
}

export function HoverPreview() {
  const [preview, setPreview] = useState<Preview | null>(null);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    const onOver = (e: MouseEvent) => {
      const el = (e.target as HTMLElement)?.closest?.(
        "[data-wikilink]"
      ) as HTMLElement | null;
      if (!el) return;
      const name = el.getAttribute("data-wikilink");
      if (!name) return;
      const rect = el.getBoundingClientRect();
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(async () => {
        const path = await api.resolveLink(name).catch(() => null);
        if (!path) return;
        const content = await api.readNote(path).catch(() => null);
        if (content == null) return;
        setPreview({
          x: Math.min(rect.left, window.innerWidth - 420),
          y: Math.min(rect.bottom + 6, window.innerHeight - 360),
          html: renderMarkdown(content.slice(0, 4000)),
        });
      }, 350);
    };
    const onOut = (e: MouseEvent) => {
      if ((e.target as HTMLElement)?.closest?.("[data-wikilink]")) {
        window.clearTimeout(timer.current);
        setPreview(null);
      }
    };
    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      window.clearTimeout(timer.current);
    };
  }, []);

  if (!preview) return null;
  return (
    <div
      className="onyx-rendered fixed z-[70] max-h-80 w-[26rem] overflow-auto rounded-lg border border-black/10 bg-white p-4 text-sm shadow-2xl ring-1 ring-black/5 dark:border-white/10 dark:bg-neutral-800 dark:ring-white/10"
      style={{ left: preview.x, top: preview.y }}
      onMouseLeave={() => setPreview(null)}
      dangerouslySetInnerHTML={{ __html: preview.html }}
    />
  );
}
