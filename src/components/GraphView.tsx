import { useEffect, useRef } from "react";
import Graph from "graphology";
import { Sigma } from "sigma";
import forceAtlas2 from "graphology-layout-forceatlas2";
import { api, noteName } from "../lib/api";
import { useStore } from "../state/store";

export function GraphView() {
  const open = useStore((s) => s.graphOpen);
  const setOpen = useStore((s) => s.setGraphOpen);
  const openNote = useStore((s) => s.openNote);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !containerRef.current) return;
    let sigma: Sigma | null = null;
    let cancelled = false;

    api.getGraph().then((data) => {
      if (cancelled || !containerRef.current) return;
      const graph = new Graph();
      const accent = "#7c6cff";

      for (const n of data.nodes) {
        if (!graph.hasNode(n.id)) {
          graph.addNode(n.id, {
            label: n.label || noteName(n.id),
            x: Math.random(),
            y: Math.random(),
            size: 4,
            color: accent,
          });
        }
      }
      for (const e of data.edges) {
        if (
          graph.hasNode(e.source) &&
          graph.hasNode(e.target) &&
          !graph.hasEdge(e.source, e.target)
        ) {
          graph.addEdge(e.source, e.target, { color: "#888", size: 0.5 });
        }
      }

      // Size nodes by degree so hubs stand out.
      graph.forEachNode((node) => {
        const deg = graph.degree(node);
        graph.setNodeAttribute(node, "size", 3 + Math.min(deg, 12));
      });

      if (graph.order > 0) {
        forceAtlas2.assign(graph, {
          iterations: 200,
          settings: forceAtlas2.inferSettings(graph),
        });
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
  }, [open, openNote, setOpen]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-40 bg-white dark:bg-neutral-900">
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
