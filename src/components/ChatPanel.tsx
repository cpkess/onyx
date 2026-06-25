import { useEffect, useMemo, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, noteName, type ChatMessage } from "../lib/api";
import { useStore } from "../state/store";
import { renderMarkdown } from "../editor/render/markdown";
import { enhanceRendered } from "../editor/render/enhance";

export function ChatPanel() {
  const openSettings = useStore((s) => s.setSettingsOpen);
  const openNote = useStore((s) => s.openNote);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState(false);
  const [useNotes, setUseNotes] = useState(false);
  const [sources, setSources] = useState<string[]>([]);
  const currentId = useRef<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);

  // Wire up streaming token/done/error events once.
  useEffect(() => {
    const unsubs = [
      listen<{ id: string; delta: string }>("ai-chat:token", (e) => {
        if (e.payload.id !== currentId.current) return;
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          if (last?.role === "assistant")
            copy[copy.length - 1] = { ...last, content: last.content + e.payload.delta };
          return copy;
        });
      }),
      listen<{ id: string; sources: string[] }>("ai-chat:sources", (e) => {
        if (e.payload.id === currentId.current) setSources(e.payload.sources);
      }),
      listen<{ id: string }>("ai-chat:done", (e) => {
        if (e.payload.id === currentId.current) setStreaming(false);
      }),
      listen<{ id: string; error: string }>("ai-chat:error", (e) => {
        if (e.payload.id !== currentId.current) return;
        setStreaming(false);
        setMessages((prev) => {
          const copy = [...prev];
          const last = copy[copy.length - 1];
          const note = `⚠️ ${e.payload.error}`;
          if (last?.role === "assistant" && !last.content)
            copy[copy.length - 1] = { ...last, content: note };
          else copy.push({ role: "assistant", content: note });
          return copy;
        });
      }),
    ];
    return () => unsubs.forEach((u) => u.then((fn) => fn()));
  }, []);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages]);

  const send = () => {
    const text = input.trim();
    if (!text || streaming) return;
    const userMsg: ChatMessage = { role: "user", content: text };
    const history = [...messages, userMsg];
    setMessages([...history, { role: "assistant", content: "" }]);
    setInput("");
    setStreaming(true);
    setSources([]);
    const id = crypto.randomUUID();
    currentId.current = id;
    const call = useNotes ? api.aiRagChat(history, id) : api.aiChat(history, id);
    call.catch((e) => {
      setStreaming(false);
      console.error("chat failed", e);
    });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="flex items-center justify-end px-2 py-1">
        <button
          onClick={() => setMessages([])}
          title="Clear chat"
          className="rounded px-1.5 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        >
          ⌫
        </button>
        <button
          onClick={() => openSettings(true)}
          title="AI settings"
          className="rounded px-1.5 text-sm text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
        >
          ⚙
        </button>
      </div>

      <div
        ref={scrollRef}
        className="flex-1 space-y-3 overflow-y-auto px-2 py-2"
        onClick={(e) => {
          const el = (e.target as HTMLElement).closest?.("[data-wikilink]");
          const name = el?.getAttribute("data-wikilink");
          if (!name) return;
          api
            .resolveLink(name)
            .then((p) => p && openNote(p))
            .catch(() => {});
        }}
      >
        {messages.length === 0 && (
          <p className="px-1 text-xs text-neutral-400">
            Ask anything. Streamed live from your local LM Studio model.
          </p>
        )}
        {messages.map((m, i) => (
          <div
            key={i}
            className={`rounded-lg px-3 py-2 text-sm ${
              m.role === "user"
                ? "bg-[var(--onyx-accent)]/15 text-neutral-800 dark:text-neutral-100"
                : "bg-black/5 text-neutral-700 dark:bg-white/5 dark:text-neutral-200"
            }`}
          >
            <div className="mb-0.5 text-[10px] uppercase tracking-wide text-neutral-400">
              {m.role}
            </div>
            {m.role === "assistant" ? (
              <RenderedMessage
                content={m.content}
                streaming={streaming && i === messages.length - 1}
              />
            ) : (
              <div className="whitespace-pre-wrap break-words">{m.content}</div>
            )}
          </div>
        ))}
        {sources.length > 0 && (
          <div className="rounded-lg border border-black/10 p-2 dark:border-white/10">
            <div className="mb-1 text-[10px] uppercase tracking-wide text-neutral-400">
              Sources
            </div>
            <div className="flex flex-wrap gap-1.5">
              {sources.map((p) => (
                <button
                  key={p}
                  onClick={() => openNote(p)}
                  className="rounded-full bg-black/5 px-2 py-0.5 text-xs text-[var(--onyx-accent)] hover:bg-black/10 dark:bg-white/10"
                >
                  {noteName(p)}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-black/10 p-2 dark:border-white/10">
        <label className="mb-1.5 flex cursor-pointer items-center gap-2 px-1 text-xs text-neutral-500">
          <input
            type="checkbox"
            checked={useNotes}
            onChange={(e) => setUseNotes(e.target.checked)}
            className="accent-[var(--onyx-accent)]"
          />
          Use my notes (RAG) — answer from your vault with citations
        </label>
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              send();
            }
          }}
          rows={2}
          placeholder="Message…  (Enter to send)"
          className="w-full resize-none rounded-md border border-black/10 bg-white px-2 py-1.5 text-sm text-neutral-800 outline-none focus:border-[var(--onyx-accent)] dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100"
        />
      </div>
    </div>
  );
}

/**
 * An assistant message rendered as markdown. While streaming, the markdown
 * re-render is throttled (~80ms) to keep the stream smooth; the heavier KaTeX +
 * mermaid pass runs only once the message is complete.
 */
function RenderedMessage({ content, streaming }: { content: string; streaming: boolean }) {
  const ref = useRef<HTMLDivElement>(null);
  const [throttled, setThrottled] = useState(content);
  const lastFlush = useRef(0);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (!streaming) {
      setThrottled(content);
      return;
    }
    const since = Date.now() - lastFlush.current;
    if (since >= 80) {
      lastFlush.current = Date.now();
      setThrottled(content);
    } else {
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => {
        lastFlush.current = Date.now();
        setThrottled(content);
      }, 80 - since);
      return () => window.clearTimeout(timer.current);
    }
  }, [content, streaming]);

  const html = useMemo(() => renderMarkdown(throttled || ""), [throttled]);

  useEffect(() => {
    if (!streaming && ref.current) enhanceRendered(ref.current);
  }, [html, streaming]);

  if (!throttled) return <div className="text-neutral-400">…</div>;
  return (
    <div
      ref={ref}
      className="onyx-rendered break-words"
      dangerouslySetInnerHTML={{ __html: html }}
    />
  );
}
