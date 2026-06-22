import { useEffect, useRef, useState } from "react";
import Graph from "graphology";
import { Sigma } from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { api, noteName, type GraphData } from "../lib/api";
import { useStore } from "../state/store";

export function GraphView() {
  const open = useStore((s) => s.graphOpen);
  const setOpen = useStore((s) => s.setGraphOpen);
  const openNote = useStore((s) => s.openNote);
  const activeTab = useStore((s) => s.activeTab);
  const containerRef = useRef<HTMLDivElement>(null);
  const [mode, setMode] = useState<"global" | "local">("global");

  useEffect(() => {
    if (!open || !containerRef.current) return;
    let sigma: Sigma | null = null;
    let cancelled = false;

    api.getGraph().then((data: GraphData) => {
      if (cancelled || !containerRef.current) return;

      // Local mode: keep the active note and its direct neighbours.
      let nodes = data.nodes;
      let edges = data.edges;
      if (mode === "local" && activeTab) {
        const keep = new Set<string>([activeTab]);
        for (const e of data.edges) {
          if (e.source === activeTab) keep.add(e.target);
          if (e.target === activeTab) keep.add(e.source);
        }
        nodes = data.nodes.filter((n) => keep.has(n.id));
        edges = data.edges.filter((e) => keep.has(e.source) && keep.has(e.target));
      }

      const graph = new Graph();
      const accent = "#7c6cff";
      for (const n of nodes) {
        if (!graph.hasNode(n.id)) {
          graph.addNode(n.id, {
            label: n.label || noteName(n.id),
            x: Math.random(),
            y: Math.random(),
            size: n.id === activeTab ? 8 : 4,
            color: n.id === activeTab ? "#e0a800" : accent,
          });
        }
      }
      for (const e of edges) {
        if (graph.hasNode(e.source) && graph.hasNode(e.target) && !graph.hasEdge(e.source, e.target)) {
          graph.addEdge(e.source, e.target, { color: "#888", size: 0.5 });
        }
      }
      graph.forEachNode((node) => {
        const deg = graph.degree(node);
        if (node !== activeTab) graph.setNodeAttribute(node, "size", 3 + Math.min(deg, 12));
      });
      if (graph.order > 0) {
        forceAtlas2.assign(graph, { iterations: 200, settings: forceAtlas2.inferSettings(graph) });
      }
      sigma = new Sigma(graph, containerRef.current, {
        labelColor: { color: "#999" },
        defaultEdgeColor: "#888",
      });
      sigma.on("clickNode", ({ node }) => {
        openNote(node);
        setOpen(false);
      });
    });

    return () => {
      cancelled = true;
      sigma?.kill();
    };
  }, [open, mode, activeTab, openNote, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-white dark:bg-neutral-900">
      <div className="absolute left-4 top-4 z-50 flex rounded-md bg-black/5 p-0.5 text-sm dark:bg-white/10">
        {(["global", "local"] as const).map((m) => (
          <button
            key={m}
            onClick={() => setMode(m)}
            className={`rounded px-3 py-1 capitalize ${
              mode === m
                ? "bg-white text-neutral-900 shadow-sm dark:bg-neutral-700 dark:text-white"
                : "text-neutral-500"
            }`}
          >
            {m}
          </button>
        ))}
      </div>
      <div className="absolute right-4 top-4 z-50">
        <button
          onClick={() => setOpen(false)}
          className="rounded-lg bg-black/5 px-3 py-1.5 text-sm text-neutral-700 hover:bg-black/10 dark:bg-white/10 dark:text-neutral-200 dark:hover:bg-white/20"
        >
          Close graph ✕
        </button>
      </div>
      <div ref={containerRef} className="h-full w-full" />
    </div>
  );
}
