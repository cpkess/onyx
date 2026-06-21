import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type AiConfig } from "../lib/api";
import { useStore } from "../state/store";

type Status =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; count: number }
  | { kind: "error"; message: string };

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);

  const [config, setConfig] = useState<AiConfig>({
    base_url: "http://localhost:1234/v1",
    chat_model: "",
    embed_model: "",
  });
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [chunkCount, setChunkCount] = useState<number>(0);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(
    null
  );
  const [saved, setSaved] = useState(false);

  // Load config + index status when opened.
  useEffect(() => {
    if (!open) return;
    api.aiGetConfig().then(setConfig).catch(() => {});
    api.aiIndexStatus().then(setChunkCount).catch(() => setChunkCount(0));
  }, [open]);

  // Listen to indexing progress events.
  useEffect(() => {
    if (!open) return;
    const unsubs = [
      listen<{ done: number; total: number }>("ai-index:progress", (e) =>
        setProgress(e.payload)
      ),
      listen<{ chunks: number }>("ai-index:done", (e) => {
        setIndexing(false);
        setProgress(null);
        setChunkCount(e.payload.chunks);
      }),
      listen<{ error: string }>("ai-index:error", (e) => {
        setIndexing(false);
        setProgress(null);
        setStatus({ kind: "error", message: e.payload.error });
      }),
    ];
    return () => {
      unsubs.forEach((u) => u.then((fn) => fn()));
    };
  }, [open]);

  if (!open) return null;

  const testConnection = async () => {
    setStatus({ kind: "testing" });
    try {
      const list = await api.aiListModels(config.base_url);
      setModels(list);
      setStatus({ kind: "ok", count: list.length });
    } catch (e) {
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const save = async () => {
    await api.aiSetConfig(config);
    setSaved(true);
    setTimeout(() => setSaved(false), 1500);
  };

  const indexVault = async () => {
    await api.aiSetConfig(config); // ensure latest config is used
    setIndexing(true);
    setProgress({ done: 0, total: 0 });
    setStatus({ kind: "idle" });
    try {
      await api.aiIndexVault();
    } catch (e) {
      setIndexing(false);
      setProgress(null);
      setStatus({ kind: "error", message: String(e) });
    }
  };

  const field =
    "w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-[var(--onyx-accent)] dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100";
  const label =
    "mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500";

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="w-[34rem] max-w-[92vw] rounded-xl bg-white p-6 shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">
            AI Settings — LM Studio
          </h2>
          <button
            onClick={() => setOpen(false)}
            className="rounded px-2 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
          >
            ✕
          </button>
        </div>

        <div className="space-y-4">
          <div>
            <label className={label}>Base URL</label>
            <div className="flex gap-2">
              <input
                className={field}
                value={config.base_url}
                onChange={(e) =>
                  setConfig({ ...config, base_url: e.target.value })
                }
                placeholder="http://localhost:1234/v1"
              />
              <button
                onClick={testConnection}
                className="shrink-0 rounded-md bg-black/5 px-3 text-sm text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/20"
              >
                {status.kind === "testing" ? "Testing…" : "Test"}
              </button>
            </div>
            {status.kind === "ok" && (
              <p className="mt-1 text-xs text-green-600 dark:text-green-400">
                Connected — {status.count} model(s) available.
              </p>
            )}
            {status.kind === "error" && (
              <p className="mt-1 text-xs text-red-500">
                {status.message} — is LM Studio running with the server started?
              </p>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={label}>Chat model</label>
              <ModelSelect
                value={config.chat_model}
                models={models}
                onChange={(v) => setConfig({ ...config, chat_model: v })}
              />
            </div>
            <div>
              <label className={label}>Embedding model</label>
              <ModelSelect
                value={config.embed_model}
                models={models}
                onChange={(v) => setConfig({ ...config, embed_model: v })}
              />
            </div>
          </div>
          {models.length === 0 && (
            <p className="text-xs text-neutral-400">
              Click “Test” to load the list of models from LM Studio.
            </p>
          )}

          <div className="rounded-lg border border-black/10 p-3 dark:border-white/10">
            <div className="mb-2 flex items-center justify-between">
              <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">
                Semantic index
              </span>
              <span className="text-xs text-neutral-400">
                {chunkCount} chunk(s) embedded
              </span>
            </div>
            <p className="mb-3 text-xs text-neutral-400">
              Embeds every note so semantic search and AI features can find
              related content. Re-run after major edits.
            </p>
            {indexing && progress && (
              <div className="mb-2">
                <div className="h-1.5 w-full overflow-hidden rounded bg-black/10 dark:bg-white/10">
                  <div
                    className="h-full bg-[var(--onyx-accent)] transition-all"
                    style={{
                      width: progress.total
                        ? `${(progress.done / progress.total) * 100}%`
                        : "10%",
                    }}
                  />
                </div>
                <p className="mt-1 text-xs text-neutral-400">
                  Embedding {progress.done}/{progress.total}…
                </p>
              </div>
            )}
            <button
              onClick={indexVault}
              disabled={indexing || !config.embed_model}
              className="rounded-md bg-[var(--onyx-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
            >
              {indexing ? "Indexing…" : "Index vault"}
            </button>
          </div>

          <div className="flex items-center justify-end gap-2 pt-2">
            {saved && (
              <span className="text-xs text-green-600 dark:text-green-400">
                Saved
              </span>
            )}
            <button
              onClick={save}
              className="rounded-md bg-black/5 px-4 py-1.5 text-sm text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/20"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelSelect({
  value,
  models,
  onChange,
}: {
  value: string;
  models: string[];
  onChange: (v: string) => void;
}) {
  const cls =
    "w-full rounded-md border border-black/10 bg-white px-2 py-2 text-sm text-neutral-800 outline-none focus:border-[var(--onyx-accent)] dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100";
  // Include the current value even if not in the fetched list.
  const options = Array.from(new Set([value, ...models].filter(Boolean)));
  return (
    <select className={cls} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— select —</option>
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
