import { useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { api, type AiConfig, type NightSettings } from "../lib/api";
import { useStore } from "../state/store";
import { commands, effectiveKeys, eventToCombo } from "../commands/registry";
import type { EditorMode } from "../editor/render/core";
import type { Update } from "@tauri-apps/plugin-updater";
import { currentVersion, checkForUpdate, installUpdate } from "../lib/updater";

type Tab = "appearance" | "editor" | "files" | "daily" | "hotkeys" | "ai" | "night" | "about";

const field =
  "w-full rounded-md border border-black/10 bg-white px-3 py-2 text-sm text-neutral-800 outline-none focus:border-[var(--onyx-accent)] dark:border-white/15 dark:bg-neutral-800 dark:text-neutral-100";
const label = "mb-1 block text-xs font-medium uppercase tracking-wide text-neutral-500";
const Row = ({ children }: { children: React.ReactNode }) => <div className="mb-4">{children}</div>;

export function Settings() {
  const open = useStore((s) => s.settingsOpen);
  const setOpen = useStore((s) => s.setSettingsOpen);
  const [tab, setTab] = useState<Tab>("appearance");

  if (!open) return null;
  const tabs: [Tab, string][] = [
    ["appearance", "Appearance"],
    ["editor", "Editor"],
    ["files", "Files & links"],
    ["daily", "Daily notes"],
    ["hotkeys", "Hotkeys"],
    ["ai", "AI (LM Studio)"],
    ["night", "Night Shift"],
    ["about", "Updates"],
  ];

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 pt-[8vh]"
      onClick={() => setOpen(false)}
    >
      <div
        className="flex h-[34rem] w-[44rem] max-w-[94vw] overflow-hidden rounded-xl bg-white shadow-2xl ring-1 ring-black/10 dark:bg-neutral-800 dark:ring-white/10"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="w-44 shrink-0 border-r border-black/10 bg-neutral-50 p-2 dark:border-white/10 dark:bg-neutral-900">
          {tabs.map(([t, lbl]) => (
            <button
              key={t}
              onClick={() => setTab(t)}
              className={`mb-0.5 block w-full rounded px-3 py-1.5 text-left text-sm ${
                tab === t
                  ? "bg-black/5 font-medium text-neutral-900 dark:bg-white/10 dark:text-white"
                  : "text-neutral-500 hover:bg-black/5 dark:hover:bg-white/5"
              }`}
            >
              {lbl}
            </button>
          ))}
        </div>
        <div className="flex-1 overflow-y-auto p-6">
          <div className="mb-4 flex items-center justify-between">
            <h2 className="text-lg font-semibold text-neutral-900 dark:text-white">
              {tabs.find(([t]) => t === tab)?.[1]}
            </h2>
            <button
              onClick={() => setOpen(false)}
              className="rounded px-2 text-neutral-400 hover:bg-black/5 dark:hover:bg-white/10"
            >
              ✕
            </button>
          </div>
          {tab === "appearance" && <Appearance />}
          {tab === "editor" && <Editor />}
          {tab === "files" && <Files />}
          {tab === "daily" && <Daily />}
          {tab === "hotkeys" && <Hotkeys />}
          {tab === "ai" && <AiSettings />}
          {tab === "night" && <NightShift />}
          {tab === "about" && <About />}
        </div>
      </div>
    </div>
  );
}

function Appearance() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const theme = useStore((s) => s.theme);
  const toggleTheme = useStore((s) => s.toggleTheme);
  return (
    <div>
      <Row>
        <label className={label}>Theme</label>
        <button
          onClick={toggleTheme}
          className="rounded-md bg-black/5 px-3 py-1.5 text-sm dark:bg-white/10"
        >
          {theme === "dark" ? "Dark" : "Light"} — toggle
        </button>
      </Row>
      <Row>
        <label className={label}>Accent color</label>
        <input
          type="color"
          value={settings.accent}
          onChange={(e) => setSettings({ accent: e.target.value })}
          className="h-9 w-16 rounded border border-black/10 bg-transparent dark:border-white/15"
        />
      </Row>
      <Row>
        <label className={label}>Font size ({settings.fontSize}px)</label>
        <input
          type="range"
          min={12}
          max={22}
          value={settings.fontSize}
          onChange={(e) => setSettings({ fontSize: Number(e.target.value) })}
          className="w-full accent-[var(--onyx-accent)]"
        />
      </Row>
      <Checkbox
        label="Serif body font"
        checked={settings.serif}
        onChange={(v) => setSettings({ serif: v })}
      />
      <Checkbox
        label="Readable line length"
        checked={settings.readableWidth}
        onChange={(v) => setSettings({ readableWidth: v })}
      />
      <Checkbox
        label="Show formatting toolbar (⌘⇧B)"
        checked={settings.showFormattingToolbar}
        onChange={(v) => setSettings({ showFormattingToolbar: v })}
      />
    </div>
  );
}

function Editor() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <Row>
      <label className={label}>Default view mode for notes</label>
      <select
        className={field}
        value={settings.defaultMode}
        onChange={(e) => setSettings({ defaultMode: e.target.value as EditorMode })}
      >
        <option value="source">Source</option>
        <option value="live">Live Preview</option>
        <option value="reading">Reading</option>
      </select>
    </Row>
  );
}

function Files() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const vault = useStore((s) => s.vault);
  const chooseVault = useStore((s) => s.chooseVault);
  return (
    <div>
      <Row>
        <label className={label}>Vault</label>
        <div className="flex items-center gap-2">
          <span className="truncate text-sm text-neutral-700 dark:text-neutral-200">
            {vault?.name ?? "No vault open"}
          </span>
          <button
            onClick={chooseVault}
            className="shrink-0 rounded-md bg-black/5 px-3 py-1.5 text-sm text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200"
          >
            Change vault…
          </button>
        </div>
      </Row>
      <Row>
        <label className={label}>Attachments folder</label>
        <input
          className={field}
          value={settings.attachmentsFolder}
          onChange={(e) => setSettings({ attachmentsFolder: e.target.value })}
          placeholder="attachments"
        />
      </Row>
      <Row>
        <label className={label}>New note location (folder)</label>
        <input
          className={field}
          value={settings.newNoteFolder}
          onChange={(e) => setSettings({ newNoteFolder: e.target.value })}
          placeholder="(vault root)"
        />
      </Row>
      <Row>
        <label className={label}>Templates folder</label>
        <input
          className={field}
          value={settings.templatesFolder}
          onChange={(e) => setSettings({ templatesFolder: e.target.value })}
          placeholder="templates"
        />
      </Row>
    </div>
  );
}

function Daily() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  return (
    <div>
      <Row>
        <label className={label}>Daily notes folder</label>
        <input
          className={field}
          value={settings.dailyFolder}
          onChange={(e) => setSettings({ dailyFolder: e.target.value })}
          placeholder="(vault root)"
        />
      </Row>
      <Row>
        <label className={label}>Date format</label>
        <input
          className={field}
          value={settings.dailyFormat}
          onChange={(e) => setSettings({ dailyFormat: e.target.value })}
          placeholder="YYYY-MM-DD"
        />
        <p className="mt-1 text-xs text-neutral-400">Tokens: YYYY MM DD HH mm ss</p>
      </Row>
      <Row>
        <label className={label}>Template note path (optional)</label>
        <input
          className={field}
          value={settings.dailyTemplate}
          onChange={(e) => setSettings({ dailyTemplate: e.target.value })}
          placeholder="templates/Daily.md"
        />
      </Row>
      <Row>
        <label className={label}>Calendar week starts on</label>
        <select
          className={field}
          value={settings.weekStart}
          onChange={(e) => setSettings({ weekStart: Number(e.target.value) as 0 | 1 })}
        >
          <option value={0}>Sunday</option>
          <option value={1}>Monday</option>
        </select>
      </Row>
    </div>
  );
}

function About() {
  const [version, setVersion] = useState("…");
  const [status, setStatus] = useState<string | null>(null);
  const [update, setUpdate] = useState<Update | null>(null);
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<number | null>(null);

  useEffect(() => {
    currentVersion().then(setVersion);
  }, []);

  const check = async () => {
    setBusy(true);
    setStatus(null);
    setUpdate(null);
    const u = await checkForUpdate();
    setBusy(false);
    if (u) {
      setUpdate(u);
      setStatus(`Onyx ${u.version} is available.`);
    } else {
      setStatus("You're up to date.");
    }
  };

  const install = async () => {
    if (!update) return;
    setBusy(true);
    try {
      await installUpdate(update, setProgress); // relaunches on success
    } catch (e) {
      setStatus(`Update failed: ${e}`);
      setBusy(false);
    }
  };

  return (
    <div>
      <Row>
        <label className={label}>Current version</label>
        <p className="text-sm text-neutral-700 dark:text-neutral-200">Onyx {version}</p>
      </Row>
      <Row>
        {update ? (
          <button
            onClick={install}
            disabled={busy}
            className="rounded-md bg-[var(--onyx-accent)] px-3 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            {busy
              ? progress === null
                ? "Downloading…"
                : progress >= 1
                  ? "Installing…"
                  : `Downloading ${Math.round(progress * 100)}%`
              : `Install ${update.version} & restart`}
          </button>
        ) : (
          <button
            onClick={check}
            disabled={busy}
            className="rounded-md bg-black/5 px-3 py-1.5 text-sm text-neutral-700 hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:text-neutral-200"
          >
            {busy ? "Checking…" : "Check for updates"}
          </button>
        )}
        {status && <p className="mt-2 text-xs text-neutral-500">{status}</p>}
      </Row>
    </div>
  );
}

function Hotkeys() {
  const settings = useStore((s) => s.settings);
  const setSettings = useStore((s) => s.setSettings);
  const [capturing, setCapturing] = useState<string | null>(null);

  useEffect(() => {
    if (!capturing) return;
    const onKey = (e: KeyboardEvent) => {
      const combo = eventToCombo(e);
      if (!combo) return;
      e.preventDefault();
      setSettings({ hotkeys: { ...settings.hotkeys, [capturing]: combo } });
      setCapturing(null);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [capturing, settings, setSettings]);

  const reset = (id: string) => {
    const next = { ...settings.hotkeys };
    delete next[id];
    setSettings({ hotkeys: next });
  };

  return (
    <div className="text-sm">
      {commands.map((c) => (
        <div key={c.id} className="flex items-center justify-between border-b border-black/5 py-1.5 dark:border-white/5">
          <span className="text-neutral-700 dark:text-neutral-200">{c.name}</span>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCapturing(c.id)}
              className="min-w-[5rem] rounded bg-black/5 px-2 py-0.5 text-xs text-neutral-600 dark:bg-white/10 dark:text-neutral-300"
            >
              {capturing === c.id ? "press keys…" : effectiveKeys(c.id) ?? "—"}
            </button>
            {settings.hotkeys[c.id] && (
              <button onClick={() => reset(c.id)} className="text-xs text-neutral-400">
                reset
              </button>
            )}
          </div>
        </div>
      ))}
    </div>
  );
}

function Checkbox({
  label: text,
  checked,
  onChange,
}: {
  label: string;
  checked: boolean;
  onChange: (v: boolean) => void;
}) {
  return (
    <label className="mb-3 flex cursor-pointer items-center gap-2 text-sm text-neutral-700 dark:text-neutral-200">
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--onyx-accent)]"
      />
      {text}
    </label>
  );
}

// ---- Night Shift ----

function NightShift() {
  const [s, setS] = useState<NightSettings | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.getNightSettings().then(setS).catch(() => {});
  }, []);

  if (!s) return <p className="text-sm text-neutral-400">Loading…</p>;

  const update = (patch: Partial<NightSettings>) => {
    const next = { ...s, ...patch };
    setS(next);
    api.setNightSettings(next).then(() => {
      setSaved(true);
      setTimeout(() => setSaved(false), 1200);
    }).catch(() => {});
  };

  const modes: [NightSettings["mode"], string, string][] = [
    ["disabled", "Disabled", "No background processing."],
    ["smart", "Smart", "Run only when charging, idle, and CPU is low."],
    ["scheduled", "Scheduled", "Run during a nightly time window while charging."],
    ["manual", "Manual", "Only run when you click “Run now”."],
  ];

  return (
    <div>
      <Row>
        <label className={label}>Processing mode</label>
        <div className="space-y-1.5">
          {modes.map(([m, title, desc]) => (
            <label key={m} className="flex cursor-pointer items-start gap-2 text-sm">
              <input
                type="radio"
                name="night-mode"
                checked={s.mode === m}
                onChange={() => update({ mode: m })}
                className="mt-1 accent-[var(--onyx-accent)]"
              />
              <span>
                <span className="font-medium text-neutral-800 dark:text-neutral-100">{title}</span>
                <span className="block text-xs text-neutral-400">{desc}</span>
              </span>
            </label>
          ))}
        </div>
      </Row>

      {s.mode === "scheduled" && (
        <Row>
          <label className={label}>Nightly window (hour, 0–23)</label>
          <div className="flex items-center gap-2">
            <input
              type="number"
              min={0}
              max={23}
              value={s.window_start}
              onChange={(e) => update({ window_start: Number(e.target.value) })}
              className={field + " w-20"}
            />
            <span className="text-sm text-neutral-400">to</span>
            <input
              type="number"
              min={0}
              max={23}
              value={s.window_end}
              onChange={(e) => update({ window_end: Number(e.target.value) })}
              className={field + " w-20"}
            />
          </div>
        </Row>
      )}

      {s.mode === "smart" && (
        <>
          <Row>
            <label className={label}>Idle before running (minutes)</label>
            <input
              type="number"
              min={1}
              value={s.idle_minutes}
              onChange={(e) => update({ idle_minutes: Number(e.target.value) })}
              className={field + " w-24"}
            />
          </Row>
          <Row>
            <label className={label}>Max CPU to start (%)</label>
            <input
              type="number"
              min={5}
              max={100}
              value={s.cpu_max}
              onChange={(e) => update({ cpu_max: Number(e.target.value) })}
              className={field + " w-24"}
            />
          </Row>
        </>
      )}

      <Row>
        <label className={label}>Apply accepted summaries by</label>
        <select
          className={field}
          value={s.summary_apply}
          onChange={(e) => update({ summary_apply: e.target.value as NightSettings["summary_apply"] })}
        >
          <option value="append">Appending a Summary section to the note</option>
          <option value="note">Creating a separate summary note</option>
        </select>
      </Row>

      <p className="text-xs text-neutral-400">
        Onyx processes in the background and never changes your notes automatically — review and apply
        suggestions from the 🌙 tab. {saved && <span className="text-green-600 dark:text-green-400">Saved.</span>}
      </p>
    </div>
  );
}

// ---- AI (LM Studio) — preserved from the original settings ----

type Status =
  | { kind: "idle" }
  | { kind: "testing" }
  | { kind: "ok"; count: number }
  | { kind: "error"; message: string };

function AiSettings() {
  const [config, setConfig] = useState<AiConfig>({
    base_url: "http://localhost:1234/v1",
    chat_model: "",
    embed_model: "",
  });
  const [models, setModels] = useState<string[]>([]);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const [chunkCount, setChunkCount] = useState(0);
  const [indexing, setIndexing] = useState(false);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    api.aiGetConfig().then(setConfig).catch(() => {});
    api.aiIndexStatus().then(setChunkCount).catch(() => setChunkCount(0));
    const unsubs = [
      listen<{ done: number; total: number }>("ai-index:progress", (e) => setProgress(e.payload)),
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
    return () => unsubs.forEach((u) => u.then((fn) => fn()));
  }, []);

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
    await api.aiSetConfig(config);
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

  return (
    <div className="space-y-4">
      <div>
        <label className={label}>Base URL</label>
        <div className="flex gap-2">
          <input
            className={field}
            value={config.base_url}
            onChange={(e) => setConfig({ ...config, base_url: e.target.value })}
            placeholder="http://localhost:1234/v1"
          />
          <button
            onClick={testConnection}
            className="shrink-0 rounded-md bg-black/5 px-3 text-sm text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200"
          >
            {status.kind === "testing" ? "Testing…" : "Test"}
          </button>
        </div>
        {status.kind === "ok" && (
          <p className="mt-1 text-xs text-green-600 dark:text-green-400">
            Connected — {status.count} model(s).
          </p>
        )}
        {status.kind === "error" && (
          <p className="mt-1 text-xs text-red-500">{status.message}</p>
        )}
      </div>
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={label}>Chat model</label>
          <ModelSelect value={config.chat_model} models={models} onChange={(v) => setConfig({ ...config, chat_model: v })} />
        </div>
        <div>
          <label className={label}>Embedding model</label>
          <ModelSelect value={config.embed_model} models={models} onChange={(v) => setConfig({ ...config, embed_model: v })} />
        </div>
      </div>
      <div className="rounded-lg border border-black/10 p-3 dark:border-white/10">
        <div className="mb-2 flex items-center justify-between">
          <span className="text-sm font-medium text-neutral-700 dark:text-neutral-200">Semantic index</span>
          <span className="text-xs text-neutral-400">{chunkCount} chunk(s)</span>
        </div>
        {indexing && progress && (
          <div className="mb-2 h-1.5 w-full overflow-hidden rounded bg-black/10 dark:bg-white/10">
            <div
              className="h-full bg-[var(--onyx-accent)] transition-all"
              style={{ width: progress.total ? `${(progress.done / progress.total) * 100}%` : "10%" }}
            />
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
      <div className="flex items-center justify-end gap-2">
        {saved && <span className="text-xs text-green-600 dark:text-green-400">Saved</span>}
        <button
          onClick={save}
          className="rounded-md bg-black/5 px-4 py-1.5 text-sm text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200"
        >
          Save
        </button>
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
  const options = Array.from(new Set([value, ...models].filter(Boolean)));
  return (
    <select className={field} value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— select —</option>
      {options.map((m) => (
        <option key={m} value={m}>
          {m}
        </option>
      ))}
    </select>
  );
}
