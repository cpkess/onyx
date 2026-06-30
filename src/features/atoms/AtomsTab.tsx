import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import {
  api,
  type Atom,
  type AtomGroup,
  type AtomPair,
  type AtomRelationView,
  type AtomsStatus,
  type DecisionTrace,
  type Tensions as TensionsData,
} from "../../lib/api";
import { useStore } from "../../state/store";

import { KIND_LABEL, ATOM_KINDS as KINDS } from "./kinds";

type Sub = "review" | "discover" | "decisions" | "tensions";

export function AtomsTab() {
  const [sub, setSub] = useState<Sub>("review");
  const [status, setStatus] = useState<AtomsStatus | null>(null);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [busy, setBusy] = useState(false);
  const [refreshKey, setRefreshKey] = useState(0);
  const activeTab = useStore((s) => s.activeTab);

  const refreshStatus = useCallback(() => {
    api.atomsStatus().then(setStatus).catch(() => {});
  }, []);
  useEffect(() => refreshStatus(), [refreshStatus, refreshKey]);

  useEffect(() => {
    const unsubs = [
      listen<{ done: number; total: number }>("atoms:progress", (e) => {
        setBusy(true);
        setProgress(e.payload);
        setRefreshKey((k) => k + 1); // stream new atoms into the list
      }),
      listen("atoms:done", () => {
        setBusy(false);
        setProgress(null);
        refreshStatus();
        setRefreshKey((k) => k + 1);
      }),
    ];
    return () => unsubs.forEach((u) => u.then((fn) => fn()));
  }, [refreshStatus]);

  // While a run is in flight, poll status so the UI reflects it (and self-heals
  // if a done event is ever missed).
  useEffect(() => {
    if (!busy) return;
    const id = window.setInterval(() => {
      api.atomsStatus().then((st) => {
        setStatus(st);
        if (!st.running) setBusy(false);
      }).catch(() => {});
    }, 1500);
    return () => window.clearInterval(id);
  }, [busy]);

  const synth = (fn: () => Promise<void>) => {
    setBusy(true); // immediate feedback
    setProgress(null);
    fn().catch(() => setBusy(false));
  };

  const subs: [Sub, string][] = [
    ["review", "Review"],
    ["discover", "Discover"],
    ["decisions", "Decisions"],
    ["tensions", "Tensions"],
  ];

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 border-b border-black/10 px-2 py-2 dark:border-white/10">
        <div className="mb-1.5 flex gap-1.5">
          <button
            onClick={() => activeTab && synth(() => api.atomsSynthesizeNote(activeTab))}
            disabled={!activeTab || busy}
            className="rounded-md bg-[var(--onyx-accent)] px-2 py-1 text-xs font-medium text-white hover:opacity-90 disabled:opacity-40"
          >
            Synthesize note
          </button>
          <button
            onClick={() => synth(() => api.atomsSynthesizeVault())}
            disabled={busy}
            className="rounded-md bg-black/5 px-2 py-1 text-xs text-neutral-700 hover:bg-black/10 disabled:opacity-40 dark:bg-white/10 dark:text-neutral-200"
          >
            Synthesize vault
          </button>
        </div>
        <div className="text-[11px] text-neutral-400">
          {busy
            ? progress
              ? `Synthesizing… ${progress.done}/${progress.total} (${status?.pending ?? 0} pending)`
              : "Synthesizing…"
            : `${status?.pending ?? 0} pending · ${status?.approved ?? 0} approved`}
        </div>
      </div>

      <div className="flex shrink-0 gap-1 px-2 py-1.5">
        {subs.map(([t, label]) => (
          <button
            key={t}
            onClick={() => setSub(t)}
            className={`flex-1 rounded-md py-1 text-xs ${
              sub === t
                ? "bg-[var(--onyx-accent)] font-medium text-white"
                : "text-neutral-500 hover:bg-black/5 dark:hover:bg-white/10"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        {sub === "review" && <Review key={refreshKey} onChange={refreshStatus} />}
        {sub === "discover" && <Discover key={refreshKey} />}
        {sub === "decisions" && <Decisions key={refreshKey} />}
        {sub === "tensions" && <Tensions key={refreshKey} />}
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: string }) {
  return (
    <span className="rounded bg-black/5 px-1.5 py-0.5 text-[10px] uppercase tracking-wide text-neutral-500 dark:bg-white/10">
      {KIND_LABEL[kind] ?? kind}
    </span>
  );
}

// ---- Review (pending inbox, grouped by source) ----

function Review({ onChange }: { onChange: () => void }) {
  const openNote = useStore((s) => s.openNote);
  const [groups, setGroups] = useState<AtomGroup[] | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());

  const load = useCallback(() => {
    api.getPendingAtoms().then(setGroups).catch(() => setGroups([]));
  }, []);
  useEffect(() => load(), [load]);

  const drop = (id: number) => {
    setGroups((gs) =>
      gs?.map((g) => ({ ...g, atoms: g.atoms.filter((a) => a.id !== id) })).filter((g) => g.atoms.length) ?? null,
    );
    setSelected((s) => {
      const n = new Set(s);
      n.delete(id);
      return n;
    });
    onChange();
  };

  const toggleSel = (id: number) =>
    setSelected((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });

  if (!groups) return <Empty>Loading…</Empty>;
  if (groups.length === 0) return <Empty>No atoms to review. Run “Synthesize” above.</Empty>;

  const mergeSelected = async () => {
    const ids = [...selected];
    if (ids.length < 2) return;
    const all = groups.flatMap((g) => g.atoms);
    const chosen = all.filter((a) => ids.includes(a.id));
    const text = chosen.map((a) => a.text).join(" ");
    const kind = chosen[0]?.kind ?? "insight";
    await api.mergeAtoms(ids, text, kind).catch(() => {});
    setSelected(new Set());
    load();
    onChange();
  };

  return (
    <div className="px-2 py-2">
      {selected.size >= 2 && (
        <button
          onClick={mergeSelected}
          className="mb-2 w-full rounded-md bg-[var(--onyx-accent)] px-2 py-1 text-xs font-medium text-white hover:opacity-90"
        >
          Merge {selected.size} selected atoms
        </button>
      )}
      {groups.map((g) => (
        <div key={g.source_path} className="mb-3">
          <button
            onClick={() => openNote(g.source_path)}
            className="mb-1 block w-full truncate text-left text-xs font-semibold text-neutral-500 hover:text-[var(--onyx-accent)]"
          >
            {g.source_name}
          </button>
          {g.atoms.map((a) => (
            <AtomCard
              key={a.id}
              atom={a}
              selected={selected.has(a.id)}
              onToggleSel={() => toggleSel(a.id)}
              onDone={() => drop(a.id)}
              onMutated={load}
            />
          ))}
        </div>
      ))}
    </div>
  );
}

function AtomCard({
  atom,
  selected,
  onToggleSel,
  onDone,
  onMutated,
}: {
  atom: Atom;
  selected: boolean;
  onToggleSel: () => void;
  onDone: () => void;
  onMutated: () => void;
}) {
  const [mode, setMode] = useState<"view" | "edit" | "split">("view");
  const [text, setText] = useState(atom.text);
  const [kind, setKind] = useState(atom.kind);
  const [splitText, setSplitText] = useState(atom.text);

  const saveEdit = async () => {
    await api.editAtom(atom.id, text, kind).catch(() => {});
    setMode("view");
    onMutated();
  };
  const doSplit = async () => {
    const parts = splitText.split("\n").map((s) => s.trim()).filter(Boolean);
    if (parts.length < 2) return;
    await api.splitAtom(atom.id, parts).catch(() => {});
    onDone();
    onMutated();
  };

  return (
    <div className="mb-1.5 rounded-md border border-black/10 p-2 dark:border-white/10">
      <div className="mb-1 flex items-center gap-2">
        <input type="checkbox" checked={selected} onChange={onToggleSel} className="accent-[var(--onyx-accent)]" />
        <KindBadge kind={atom.kind} />
        <SubBar value={atom.substantiation} />
        <span className="ml-auto text-[10px] text-neutral-400">{Math.round(atom.confidence * 100)}%</span>
      </div>

      {mode === "view" && (
        <>
          <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-100">{atom.text}</p>
          {atom.evidence && <Evidence text={atom.evidence} />}
        </>
      )}
      {mode === "edit" && (
        <div className="space-y-1">
          <textarea
            value={text}
            onChange={(e) => setText(e.target.value)}
            className="w-full rounded border border-black/10 bg-white p-1 text-sm dark:border-white/15 dark:bg-neutral-800"
            rows={3}
          />
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="rounded border border-black/10 bg-white p-1 text-xs dark:border-white/15 dark:bg-neutral-800"
          >
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
      )}
      {mode === "split" && (
        <textarea
          value={splitText}
          onChange={(e) => setSplitText(e.target.value)}
          placeholder="One atom per line…"
          className="w-full rounded border border-black/10 bg-white p-1 text-sm dark:border-white/15 dark:bg-neutral-800"
          rows={4}
        />
      )}

      <div className="mt-2 flex flex-wrap gap-1.5">
        {mode === "view" ? (
          <>
            <Btn primary onClick={() => api.approveAtom(atom.id).then(onDone)}>
              Approve
            </Btn>
            <Btn onClick={() => api.rejectAtom(atom.id).then(onDone)}>Reject</Btn>
            <Btn onClick={() => setMode("edit")}>Edit</Btn>
            <Btn onClick={() => setMode("split")}>Split</Btn>
          </>
        ) : mode === "edit" ? (
          <>
            <Btn primary onClick={saveEdit}>
              Save
            </Btn>
            <Btn onClick={() => setMode("view")}>Cancel</Btn>
          </>
        ) : (
          <>
            <Btn primary onClick={doSplit}>
              Split
            </Btn>
            <Btn onClick={() => setMode("view")}>Cancel</Btn>
          </>
        )}
      </div>
    </div>
  );
}

// ---- Discover ----

function Discover() {
  const openNote = useStore((s) => s.openNote);
  const [kind, setKind] = useState("");
  const [query, setQuery] = useState("");
  const [relation, setRelation] = useState("");
  const [atoms, setAtoms] = useState<Atom[]>([]);

  const load = useCallback(() => {
    api
      .getAtoms({
        kind: kind || undefined,
        query: query || undefined,
        relation: relation || undefined,
      })
      .then(setAtoms)
      .catch(() => setAtoms([]));
  }, [kind, query, relation]);
  useEffect(() => {
    const id = window.setTimeout(load, 200);
    return () => window.clearTimeout(id);
  }, [load]);

  return (
    <div className="px-2 py-2">
      <div className="mb-2 space-y-1.5">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search knowledge…"
          className="w-full rounded border border-black/10 bg-white px-2 py-1 text-sm dark:border-white/15 dark:bg-neutral-800"
        />
        <div className="flex gap-1.5">
          <select
            value={kind}
            onChange={(e) => setKind(e.target.value)}
            className="flex-1 rounded border border-black/10 bg-white p-1 text-xs dark:border-white/15 dark:bg-neutral-800"
          >
            <option value="">All types</option>
            {KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABEL[k]}
              </option>
            ))}
          </select>
          <select
            value={relation}
            onChange={(e) => setRelation(e.target.value)}
            className="flex-1 rounded border border-black/10 bg-white p-1 text-xs dark:border-white/15 dark:bg-neutral-800"
          >
            <option value="">Any relation</option>
            <option value="contradicts">Contradictions</option>
            <option value="supports">Supports</option>
            <option value="extends">Extends</option>
            <option value="similar_to">Similar</option>
          </select>
        </div>
      </div>
      {atoms.length === 0 && <Empty>No approved atoms match.</Empty>}
      {atoms.map((a) => (
        <DiscoverCard key={a.id} atom={a} onOpen={() => openNote(a.source_path)} />
      ))}
    </div>
  );
}

function DiscoverCard({ atom, onOpen }: { atom: Atom; onOpen: () => void }) {
  const [rels, setRels] = useState<AtomRelationView[] | null>(null);
  const toggle = () => {
    if (rels) return setRels(null);
    api.getRelations(atom.id).then(setRels).catch(() => setRels([]));
  };
  return (
    <div className="mb-1.5 rounded-md border border-black/10 p-2 dark:border-white/10">
      <div className="mb-1 flex items-center gap-2">
        <KindBadge kind={atom.kind} />
        <SubBar value={atom.substantiation} />
        <button onClick={onOpen} className="ml-auto truncate text-[10px] text-neutral-400 hover:text-[var(--onyx-accent)]">
          {atom.source_path.split("/").pop()?.replace(/\.md$/, "")}
        </button>
      </div>
      <p className="whitespace-pre-wrap text-sm text-neutral-800 dark:text-neutral-100">{atom.text}</p>
      {atom.evidence && <Evidence text={atom.evidence} />}
      <button onClick={toggle} className="mt-1 text-[11px] text-[var(--onyx-accent)] hover:underline">
        {rels ? "Hide" : "Relations"}
      </button>
      {rels &&
        (rels.length === 0 ? (
          <p className="mt-1 text-[11px] text-neutral-400">No relations yet.</p>
        ) : (
          <div className="mt-1 space-y-1">
            {rels.map((r, i) => (
              <div key={i} className="text-[11px] text-neutral-500">
                <span className="font-medium text-neutral-600 dark:text-neutral-300">
                  {r.direction === "out" ? r.kind : `${r.kind} (←)`}
                </span>
                : {r.atom.text}
              </div>
            ))}
          </div>
        ))}
    </div>
  );
}

// ---- Decisions ----

function Decisions() {
  const openNote = useStore((s) => s.openNote);
  const [decisions, setDecisions] = useState<Atom[]>([]);
  const [trace, setTrace] = useState<DecisionTrace | null>(null);

  useEffect(() => {
    api.getDecisions().then(setDecisions).catch(() => setDecisions([]));
  }, []);

  if (decisions.length === 0)
    return <Empty>No approved decisions yet. Approve atoms of type “Decision”.</Empty>;

  return (
    <div className="px-2 py-2">
      {!trace ? (
        decisions.map((d) => (
          <button
            key={d.id}
            onClick={() => api.getDecisionTrace(d.id).then(setTrace)}
            className="mb-1.5 block w-full rounded-md border border-black/10 p-2 text-left text-sm hover:bg-black/5 dark:border-white/10 dark:hover:bg-white/5"
          >
            {d.text}
          </button>
        ))
      ) : (
        <div>
          <button onClick={() => setTrace(null)} className="mb-2 text-[11px] text-[var(--onyx-accent)]">
            ← All decisions
          </button>
          <div className="mb-2 rounded-md border border-[var(--onyx-accent)]/40 bg-[var(--onyx-accent)]/5 p-2">
            <KindBadge kind="decision" />
            <p className="mt-1 text-sm text-neutral-800 dark:text-neutral-100">{trace.decision.text}</p>
          </div>
          <div className="mb-1 text-xs font-semibold text-neutral-500">Supported by</div>
          {trace.supporting.length === 0 && <Empty>No supporting atoms linked yet.</Empty>}
          {trace.supporting.map((a) => (
            <div key={a.id} className="mb-1.5 rounded-md border border-black/10 p-2 dark:border-white/10">
              <div className="mb-1 flex items-center gap-2">
                <KindBadge kind={a.kind} />
                <button
                  onClick={() => openNote(a.source_path)}
                  className="ml-auto truncate text-[10px] text-neutral-400 hover:text-[var(--onyx-accent)]"
                >
                  {a.source_path.split("/").pop()?.replace(/\.md$/, "")}
                </button>
              </div>
              <p className="text-sm text-neutral-800 dark:text-neutral-100">{a.text}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ---- Tensions (contradiction radar) ----

function Tensions() {
  const openNote = useStore((s) => s.openNote);
  const [data, setData] = useState<TensionsData | null>(null);

  const load = useCallback(() => {
    api.getTensions().then(setData).catch(() => setData({ contradictions: [], duplicates: [] }));
  }, []);
  useEffect(() => load(), [load]);

  if (!data) return <Empty>Loading…</Empty>;
  const nothing = data.contradictions.length === 0 && data.duplicates.length === 0;
  if (nothing)
    return (
      <Empty>
        No tensions found. Enable “Infer relationships” in Settings → Atoms (and re-approve atoms) to
        detect contradictions.
      </Empty>
    );

  const merge = async (p: AtomPair) => {
    await api.mergeAtoms([p.a.id, p.b.id], p.a.text, p.a.kind).catch(() => {});
    load();
  };

  return (
    <div className="px-2 py-2">
      {data.contradictions.length > 0 && (
        <div className="mb-3">
          <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Contradictions
          </div>
          {data.contradictions.map((p, i) => (
            <div key={i} className="mb-1.5 rounded-md border border-red-500/30 p-2">
              <AtomLine atom={p.a} onOpen={() => openNote(p.a.source_path)} />
              <div className="my-1 text-center text-xs text-red-500">⚡ contradicts</div>
              <AtomLine atom={p.b} onOpen={() => openNote(p.b.source_path)} />
            </div>
          ))}
        </div>
      )}
      {data.duplicates.length > 0 && (
        <div>
          <div className="mb-1 px-1 text-xs font-semibold uppercase tracking-wide text-neutral-500">
            Possible duplicates
          </div>
          {data.duplicates.map((p, i) => (
            <div key={i} className="mb-1.5 rounded-md border border-black/10 p-2 dark:border-white/10">
              <AtomLine atom={p.a} onOpen={() => openNote(p.a.source_path)} />
              <AtomLine atom={p.b} onOpen={() => openNote(p.b.source_path)} />
              <button
                onClick={() => merge(p)}
                className="mt-1 rounded bg-[var(--onyx-accent)] px-2 py-0.5 text-xs font-medium text-white hover:opacity-90"
              >
                Merge
              </button>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function AtomLine({ atom, onOpen }: { atom: Atom; onOpen: () => void }) {
  return (
    <div className="flex items-baseline gap-2">
      <KindBadge kind={atom.kind} />
      <span className="flex-1 text-sm text-neutral-800 dark:text-neutral-100">{atom.text}</span>
      <button onClick={onOpen} className="text-[10px] text-neutral-400 hover:text-[var(--onyx-accent)]">
        {atom.source_path.split("/").pop()?.replace(/\.md$/, "")}
      </button>
    </div>
  );
}

// ---- shared ----

function Btn({
  children,
  onClick,
  primary,
}: {
  children: React.ReactNode;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      className={
        primary
          ? "rounded bg-[var(--onyx-accent)] px-2 py-0.5 text-xs font-medium text-white hover:opacity-90"
          : "rounded bg-black/5 px-2 py-0.5 text-xs text-neutral-600 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-300"
      }
    >
      {children}
    </button>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-3 text-xs text-neutral-400">{children}</p>;
}

// Substantiation meter: red (weak/claim) → amber → green (well-substantiated).
function SubBar({ value }: { value: number }) {
  const pct = Math.round(Math.max(0, Math.min(1, value)) * 100);
  const color = value >= 0.7 ? "#2ecc71" : value >= 0.4 ? "#e0a800" : "#e0524c";
  return (
    <span title={`Substantiation ${pct}%`} className="inline-block h-1.5 w-8 rounded-full bg-black/10 dark:bg-white/10">
      <span className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </span>
  );
}

function Evidence({ text }: { text: string }) {
  return (
    <p className="mt-1 border-l-2 border-black/10 pl-2 text-xs italic text-neutral-400 dark:border-white/10">
      “{text}”
    </p>
  );
}
