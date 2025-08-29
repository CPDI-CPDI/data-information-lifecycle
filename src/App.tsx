// No default React import needed
import { useEffect, useMemo, useRef, useState } from "react";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";

// IMPORTANT: use type-only imports for types when verbatimModuleSyntax is on
import type { Node as VisNode, Edge as VisEdge } from "vis-network";
import { Network } from "vis-network";
import { DataSet } from "vis-data";

// REMOVE this line if you still have it in App.tsx (belongs in vite.config.ts only)
// import tailwindcss from "@tailwindcss/vite";

/**
 * Quick start notes (run these in your Codespace terminal):
 *
 *   npm install papaparse vis-network xlsx tailwindcss @tailwindcss/vite
 *
 * Tailwind v4: ensure vite.config.ts includes the plugin:
 *   import tailwindcss from '@tailwindcss/vite'
 *   export default defineConfig({ plugins: [react(), tailwindcss()], base })
 *
 * Place CSVs in /public: nodes_final.csv, edges_final.csv
 */

// -----------------------------
// Types matching cleaned CSVs
// -----------------------------
export type NodeRow = {
  Name: string;
  Family: string;
  NameID: string;
  FamilyID: string;
  Definition: string;
  size?: string | number; // optional, unused for layout but supported if present
  [k: string]: any;
};

export type EdgeRow = {
  id: string | number;
  source: string; // NameID
  target: string; // NameID
  group?: string; // FamilyID(source)
  description?: string; // default "No description"
  [k: string]: any;
};

// -----------------------------
// CSV helpers
// -----------------------------
type CsvResult<T> = { data: T[]; errors?: unknown[]; meta?: unknown };

async function fetchCsv<T extends Record<string, any> = Record<string, any>>(url: string): Promise<T[]> {
  const res = await fetch(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`Failed to load ${url}: ${res.status}`);
  const text = await res.text();

  // No generic on parse (avoids TS2347). Cast to a minimal local type.
  const parsed = Papa.parse(text, {
    header: true,
    skipEmptyLines: true,
  }) as unknown as CsvResult<T>;

  // Filter out empty/objectless rows safely
  return (parsed.data ?? []).filter(
    (row) => row && typeof row === "object" && Object.keys(row as object).length > 0
  );
}

function makeColorForFamily(family: string): { border: string; background: string; highlight: { border: string; background: string } } {
  // deterministic pastel-ish palette per family using a hash
  let h = 0;
  for (let i = 0; i < family.length; i++) h = (h * 31 + family.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 55; //%
  const light = 72; //%
  const color = `hsl(${hue} ${sat}% ${light}%)`;
  const colorBorder = `hsl(${hue} ${sat + 10}% ${Math.max(35, light - 25)}%)`;
  const hiBg = `hsl(${hue} ${sat + 5}% ${Math.min(92, light + 15)}%)`;
  const hiBorder = `hsl(${hue} ${sat + 15}% ${Math.max(30, light - 30)}%)`;
  return { border: colorBorder, background: color, highlight: { border: hiBorder, background: hiBg } };
}

// -----------------------------
// Graph + Filtering logic
// -----------------------------
type FilterMode = null | "id" | "group" | "legend";

function buildVisDatasets(
  nodes: NodeRow[],
  edges: EdgeRow[],
  options?: { showEdgeTooltips?: boolean; activeNodeIds?: Set<string> | null }
) {
  const nodeMapById: Record<string, NodeRow> = Object.fromEntries(nodes.map((n) => [n.NameID, n]));
  const familyColors: Record<string, ReturnType<typeof makeColorForFamily>> = {};

  const visNodes = new DataSet<VisNode>(
    nodes.map((n) => {
      if (!familyColors[n.Family]) familyColors[n.Family] = makeColorForFamily(n.Family);
      const color = familyColors[n.Family];
      const active = options?.activeNodeIds ? options.activeNodeIds.has(n.NameID) : true;
      return {
        id: n.NameID,
        label: n.Name,
        title: n.Definition || n.Name,
        group: n.Family,
        shape: "dot",
        size: Math.min(40, Math.max(16, Number(n.size ?? 18))),
        color: active
          ? { border: color.border, background: color.background, highlight: color.highlight }
          : { border: "#cccccc", background: "#e5e7eb", highlight: { border: "#a1a1aa", background: "#e5e7eb" } },
        font: { color: active ? "#111827" : "#9ca3af", face: "ui-sans-serif, system-ui" },
      } satisfies VisNode;
    })
  );

  const edgeTooltips = !!options?.showEdgeTooltips;
  const visEdges = new DataSet<VisEdge>(
    edges.map((e) => {
      const src = nodeMapById[e.source];
      const color = src ? makeColorForFamily(src.Family) : { border: "#9ca3af", background: "#d1d5db", highlight: { border: "#6b7280", background: "#e5e7eb" } };
      const smooth: any = { enabled: true, type: "dynamic" };
      return {
        id: e.id,
        from: e.source,
        to: e.target,
        arrows: "to",
        color: { color: color.border, highlight: color.highlight.border },
        smooth,
        title: edgeTooltips ? (e.description || "No description") : undefined,
      } satisfies VisEdge;
    })
  );

  return { visNodes, visEdges };
}

// Dim/un-dim helpers
function applyDimStyles(
  visNodes: DataSet<VisNode>,
  visEdges: DataSet<VisEdge>,
  keepNodeIds: Set<string>,
  keepEdgeIds: Set<string>
) {
  const nodes = visNodes.get();
  const edges = visEdges.get();

  const updatesN: Partial<VisNode & { id: string }>[] = [];
  const updatesE: Partial<VisEdge & { id: string | number }>[] = [];

  for (const n of nodes) {
    const dim = !keepNodeIds.has(String(n.id));
    updatesN.push({ id: String(n.id), opacity: dim ? 0.25 : 1.0, font: { color: dim ? "#9ca3af" : "#111827" } as any });
  }
  for (const e of edges) {
    const dim = !keepEdgeIds.has(String(e.id));
    updatesE.push({ id: String(e.id), color: { color: dim ? "#d1d5db" : (e as any).color?.color || "#4b5563" } as any });
  }
  visNodes.update(updatesN);
  visEdges.update(updatesE);
}

function clearDimStyles(visNodes: DataSet<VisNode>, visEdges: DataSet<VisEdge>) {
  const nodes = visNodes.get();
  const edges = visEdges.get();
  const updatesN = nodes.map((n) => ({ id: String(n.id), opacity: 1.0, font: { color: "#111827" } as any }));
  const updatesE = edges.map((e) => ({ id: String(e.id), color: (e as any).color }));
  visNodes.update(updatesN);
  visEdges.update(updatesE);
}

function bfsReachable(start: string, edgesSet: Set<string> /* key: src->tgt */): Set<string> {
  const q: string[] = [start];
  const seen = new Set<string>([start]);
  while (q.length) {
    const u = q.shift()!;
    // scan edgesSet for outgoing from u
    for (const key of edgesSet) {
      const [s, t] = key.split("->");
      if (s === u && !seen.has(t)) {
        seen.add(t);
        q.push(t);
      }
    }
  }
  return seen;
}

// -----------------------------
// Main Component
// -----------------------------
export default function App() {
  const base = import.meta.env.BASE_URL || "/";

  // Data
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [edges, setEdges] = useState<EdgeRow[]>([]);

  // Mappings
  const nodeById = useMemo(() => Object.fromEntries(nodes.map((n) => [n.NameID, n])), [nodes]);
  const nameToId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.Name.toLowerCase(), n.NameID])), [nodes]);
  const groups = useMemo(() => Array.from(new Set(nodes.map((n) => n.Family))).sort(), [nodes]);

  // Graph
  const containerRef = useRef<HTMLDivElement | null>(null);
  const networkRef = useRef<Network | null>(null);
  const visNodesRef = useRef<DataSet<VisNode> | null>(null);
  const visEdgesRef = useRef<DataSet<VisEdge> | null>(null);

  // Filter state
  const [filterMode, setFilterMode] = useState<FilterMode>(null);
  const [selectedName, setSelectedName] = useState<string>(""); // select by Name
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [legendActive, setLegendActive] = useState<Set<string>>(new Set(groups)); // families currently visible when legend mode

  // Lifecycle editor state
  const [lifecycleMode, setLifecycleMode] = useState<"none" | "create" | "edit">("none");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Active edges (custom lifecycle) as keys "src->tgt"
  const [activeEdgeKeys, setActiveEdgeKeys] = useState<Set<string>>(new Set());
  const startNodeId = useMemo(() => {
    const n = nodes.find((r) => r.Name.toLowerCase() === "specify needs");
    return n?.NameID ?? "";
  }, [nodes]);
  const disposeId = useMemo(() => nodes.find((r) => r.Name.toLowerCase() === "dispose")?.NameID ?? "", [nodes]);
  const shareId = useMemo(() => nodes.find((r) => r.Name.toLowerCase() === "share")?.NameID ?? "", [nodes]);

  const activeNodeIds = useMemo(() => bfsReachable(startNodeId, activeEdgeKeys), [startNodeId, activeEdgeKeys]);

  // Build adjacency for editor
  const outgoingBySource = useMemo(() => {
    const m = new Map<string, EdgeRow[]>();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, []);
      m.get(e.source)!.push(e);
    }
    return m;
  }, [edges]);

  // Load CSVs once
  useEffect(() => {
    (async () => {
      try {
        const [n, e] = await Promise.all([
          fetchCsv<NodeRow>(`${base}nodes_final.csv`),
          fetchCsv<EdgeRow>(`${base}edges_final.csv`),
        ]);
        setNodes(n);
        setEdges(e);
      } catch (err) {
        console.error(err);
      }
    })();
  }, [base]);

  // Build / rebuild Network
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;
    const { visNodes, visEdges } = buildVisDatasets(nodes, edges, {
      showEdgeTooltips: lifecycleMode !== "none",
      activeNodeIds: lifecycleMode !== "none" ? activeNodeIds : null,
    });

    visNodesRef.current = visNodes;
    visEdgesRef.current = visEdges;

    const net = new Network(containerRef.current, { nodes: visNodes, edges: visEdges }, {
      autoResize: true,
      physics: { solver: "forceAtlas2Based", stabilization: { iterations: 150 } },
      interaction: { hover: true, tooltipDelay: 120, multiselect: true },
      layout: { improvedLayout: true },
      edges: { arrows: { to: { enabled: true, scaleFactor: 0.8 } } },
    });

    networkRef.current = net;
    // Fit once
    setTimeout(() => net.fit({ animation: { duration: 600, easingFunction: "easeInOutQuad" } }), 50);

    return () => {
      net.destroy();
      networkRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, lifecycleMode, activeNodeIds]);

  // -----------------------------
  // Filtering behaviours
  // -----------------------------
  function clearFilters() {
    setFilterMode(null);
    setSelectedName("");
    setSelectedGroup("");
    setLegendActive(new Set(groups));
    if (networkRef.current && visNodesRef.current && visEdgesRef.current) {
      clearDimStyles(visNodesRef.current, visEdgesRef.current);
    }
  }

  function applySelectByName(name: string) {
    setFilterMode("id");
    setSelectedName(name);
    setSelectedGroup("");
    setLegendActive(new Set(groups));

    if (!networkRef.current || !visNodesRef.current || !visEdgesRef.current) return;
    const id = nameToId[name.toLowerCase()];
    if (!id) return;

    // Keep: the node itself, all its incoming/outgoing edges, and the nodes at the other ends of those edges
    const visNodes = visNodesRef.current;
    const visEdges = visEdgesRef.current;

    const keepNodes = new Set<string>([id]);
    const keepEdges = new Set<string>();

    for (const e of visEdges.get()) {
      const eid = String(e.id);
      const from = String(e.from);
      const to = String(e.to);
      if (from === id || to === id) {
        keepEdges.add(eid);
        keepNodes.add(from);
        keepNodes.add(to);
      }
    }
    applyDimStyles(visNodes, visEdges, keepNodes, keepEdges);
  }

  function applySelectByGroup(group: string) {
    setFilterMode("group");
    setSelectedGroup(group);
    setSelectedName("");
    setLegendActive(new Set(groups));

    if (!networkRef.current || !visNodesRef.current || !visEdgesRef.current) return;
    const visNodes = visNodesRef.current;
    const visEdges = visEdgesRef.current;

    const groupNodeIds = new Set(nodes.filter((n) => n.Family === group).map((n) => n.NameID));
    const keepNodes = new Set<string>(groupNodeIds);
    const keepEdges = new Set<string>();

    for (const e of visEdges.get()) {
      const from = String(e.from);
      const to = String(e.to);
      // keep outgoing edges of that group's nodes
      if (groupNodeIds.has(from)) {
        keepEdges.add(String(e.id));
        keepNodes.add(to);
      }
    }
    applyDimStyles(visNodes, visEdges, keepNodes, keepEdges);
  }

  function toggleLegendFamily(fam: string) {
    // switch to legend mode (mutually exclusive with others)
    if (filterMode !== "legend") {
      // isolate-on-first-click behavior
      setLegendActive(new Set([fam]));
      setFilterMode("legend");
      setSelectedName("");
      setSelectedGroup("");
    } else {
      // Toggle fam on/off within legend mode
      const next = new Set(legendActive);
      if (next.has(fam)) next.delete(fam); else next.add(fam);
      if (next.size === 0) {
        // avoid empty — keep at least one
        next.add(fam);
      }
      setLegendActive(next);
    }

    if (!networkRef.current || !visNodesRef.current || !visEdgesRef.current) return;
    const visNodes = visNodesRef.current;
    const visEdges = visEdgesRef.current;

    const activeFamilies = filterMode === "legend" ? legendActive : new Set([fam]);
    const keepNodes = new Set(nodes.filter((n) => activeFamilies.has(n.Family)).map((n) => n.NameID));
    const keepEdges = new Set<string>();
    for (const e of visEdges.get()) {
      const from = String(e.from);
      const to = String(e.to);
      if (keepNodes.has(from)) keepEdges.add(String(e.id));
      if (keepNodes.has(to)) keepNodes.add(to);
    }
    applyDimStyles(visNodes, visEdges, keepNodes, keepEdges);
  }

  // -----------------------------
  // Graph controls
  // -----------------------------
  function zoomIn() {
    networkRef.current?.moveTo({ scale: (networkRef.current?.getScale() || 1) * 1.2 });
  }
  function zoomOut() {
    networkRef.current?.moveTo({ scale: (networkRef.current?.getScale() || 1) / 1.2 });
  }
  function fit() {
    networkRef.current?.fit({ animation: { duration: 500, easingFunction: "easeInOutQuad" } });
  }
  function pan(dx: number, dy: number) {
    const p = networkRef.current?.getViewPosition();
    const s = networkRef.current?.getScale() || 1;
    if (!p) return;
    networkRef.current?.moveTo({ position: { x: p.x - dx / s, y: p.y - dy / s } });
  }

  // -----------------------------
  // Custom Lifecycle: validate + save
  // -----------------------------
  function validateLifecycle(): { ok: true } | { ok: false; errors: string[] } {
    const errors: string[] = [];
    if (!title.trim()) errors.push("Title is required.");
    if (!description.trim()) errors.push("Description is required.");
    if (!startNodeId) errors.push("Start node 'Specify needs' not found in All Nodes.");
    if (!disposeId) errors.push("End node 'Dispose' not found in All Nodes.");

    // Reachability
    const reachable = bfsReachable(startNodeId, activeEdgeKeys);
    if (!reachable.has(disposeId)) errors.push("'Dispose' must be reachable from 'Specify needs'.");

    // Terminal nodes must be {Dispose, Share}
    const activeSources = new Set(Array.from(activeEdgeKeys).map((k) => k.split("->")[0]));
    const terminals = Array.from(reachable).filter((n) => !activeSources.has(n)); // no outgoing active edge
    for (const t of terminals) {
      if (t !== disposeId && t !== shareId) {
        const nodeName = nodeById[t]?.Name || t;
        errors.push(`Terminal node '${nodeName}' is not allowed (only Dispose or Share).`);
      }
    }

    return errors.length ? { ok: false, errors } : { ok: true };
  }

  function saveLifecycle() {
    const check = validateLifecycle();
    if (!("ok" in check) || check.ok !== true) return;

    // Collect active nodes + edges
    const nodeIds = Array.from(activeNodeIds);
    const nodesOut = nodeIds.map((id) => nodeById[id]).filter(Boolean) as NodeRow[];

    const edgesOutRaw: EdgeRow[] = [];
    for (const key of activeEdgeKeys) {
      const [src, tgt] = key.split("->");
      const found = edges.find((e) => e.source === src && e.target === tgt);
      if (found) edgesOutRaw.push(found);
    }

    // Re-ID edges 1..N and ensure group/description present
    const edgesOut = edgesOutRaw.map((e, i) => ({
      id: i + 1,
      source: e.source,
      target: e.target,
      group: nodeById[e.source]?.FamilyID || "",
      description: e.description || "No description",
    }));

    const now = new Date();
    const meta = [["Title", "Description", "CreatedDate", "CreatedTime"], [title, description, now.toISOString().slice(0, 10), now.toTimeString().slice(0, 8)]];

    const wb = XLSX.utils.book_new();
    const wsMeta = XLSX.utils.aoa_to_sheet(meta);
    const wsNodes = XLSX.utils.json_to_sheet(nodesOut);
    const wsEdges = XLSX.utils.json_to_sheet(edgesOut);
    XLSX.utils.book_append_sheet(wb, wsMeta, "Metadata");
    XLSX.utils.book_append_sheet(wb, wsNodes, "Nodes");
    XLSX.utils.book_append_sheet(wb, wsEdges, "Edges");

    const safeTitle = (title || "CustomLifecycle").replace(/[^a-z0-9]+/gi, "_");
    XLSX.writeFile(wb, `${safeTitle}_${now.toISOString().slice(0, 10)}.xlsx`);
  }

  // -----------------------------
  // Custom Lifecycle: UI helpers
  // -----------------------------
  function setEdgeActive(edge: EdgeRow, active: boolean) {
    const key = `${edge.source}->${edge.target}`;
    const next = new Set(activeEdgeKeys);
    if (active) next.add(key); else next.delete(key);
    setActiveEdgeKeys(next);
  }

  function resetLifecycle() {
    setLifecycleMode("none");
    setTitle("");
    setDescription("");
    setActiveEdgeKeys(new Set());
    clearFilters();
  }

  function startLifecycleCreate() {
    setLifecycleMode("create");
    setTitle("");
    setDescription("");
    setActiveEdgeKeys(new Set());
    // Focus start node on the graph
    if (networkRef.current && startNodeId) {
      networkRef.current.focus(startNodeId, { animation: { duration: 500, easingFunction: "easeInOutQuad" } });
    }
  }

  async function handleLifecycleLoad(file: File) {
    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab);
      const wsNodes = wb.Sheets["Nodes"];
      const wsEdges = wb.Sheets["Edges"];
      const wsMeta = wb.Sheets["Metadata"];
      if (!wsNodes || !wsEdges || !wsMeta) throw new Error("Expected sheets: Metadata, Nodes, Edges");
      const inNodes = XLSX.utils.sheet_to_json<NodeRow>(wsNodes);
      const inEdges = XLSX.utils.sheet_to_json<EdgeRow>(wsEdges);
      const metaAoa = XLSX.utils.sheet_to_json<any>(wsMeta, { header: 1 }) as any[][];
      let t = "", d = "";
      if (metaAoa && metaAoa[1]) {
        t = metaAoa[1][0] || "";
        d = metaAoa[1][1] || "";
      }

      // Validate strict subset
      const nodeIds = new Set(nodes.map((n) => n.NameID));
      const edgePairs = new Set(edges.map((e) => `${e.source}->${e.target}`));

      const errors: string[] = [];
      for (const n of inNodes) {
        const id = n.NameID;
        if (!id || !nodeIds.has(id)) errors.push(`Nodes sheet: NameID '${id || "(missing)"}' not found in All Nodes`);
      }
      for (const e of inEdges) {
        const key = `${e.source}->${e.target}`;
        if (!edgePairs.has(key)) errors.push(`Edges sheet: pair '${key}' not found in All Edges`);
      }
      if (errors.length) {
        alert("Import failed:\n" + errors.join("\n"));
        return;
      }

      // Load into editor
      setLifecycleMode("edit");
      setTitle(t);
      setDescription(d);
      const next = new Set<string>();
      for (const e of inEdges) next.add(`${e.source}->${e.target}`);
      setActiveEdgeKeys(next);

      setTimeout(() => {
        if (networkRef.current && startNodeId) networkRef.current.focus(startNodeId, { animation: true });
      }, 100);
    } catch (err: any) {
      alert("Failed to load lifecycle: " + err?.message);
    }
  }

  // Limit filter options to active subset when in lifecycle mode
  const filterableNodes = useMemo(() => (lifecycleMode === "none" ? nodes : nodes.filter((n) => activeNodeIds.has(n.NameID))), [nodes, lifecycleMode, activeNodeIds]);
  const filterableGroups = useMemo(() => Array.from(new Set(filterableNodes.map((n) => n.Family))).sort(), [filterableNodes]);

  // -----------------------------
  // Render
  // -----------------------------
  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-[360px_1fr]">
      {/* Left Pane */}
      <aside className="border-r bg-white/70 backdrop-blur p-4 flex flex-col gap-4">
        <div className="flex items-center justify-between">
          <h2 className="text-lg font-semibold">Lifecycle Builder</h2>
          {lifecycleMode === "none" ? (
            <div className="flex gap-2">
              <button onClick={startLifecycleCreate} className="px-3 py-1.5 rounded-md bg-emerald-600 text-white hover:bg-emerald-700">Start Custom Lifecycle</button>
              <label className="px-3 py-1.5 rounded-md border cursor-pointer bg-white hover:bg-gray-50">
                Edit Custom Lifecycle
                <input type="file" accept=".xlsx" className="hidden" onChange={(e) => e.target.files && handleLifecycleLoad(e.target.files[0])} />
              </label>
            </div>
          ) : (
            <button
              className="px-3 py-1.5 rounded-md bg-rose-600 text-white hover:bg-rose-700"
              onClick={() => {
                const lose = confirm("Cancel Custom Lifecycle? Unsaved progress will be lost.");
                if (lose) resetLifecycle();
              }}
            >
              Cancel Custom Lifecycle
            </button>
          )}
        </div>

        {lifecycleMode !== "none" && (
          <div className="space-y-3">
            <p className="text-sm text-gray-600">
              Lifecycles start at <b>Specify needs</b> and end at <b>Dispose</b>. Branches may rejoin the main path or end at <b>Share</b>. Cycles are allowed.
              A lifecycle must have a <b>Title</b> and <b>Description</b>. Bi-directional edges require two selections.
            </p>
            <div className="grid grid-cols-1 gap-2">
              <input className="border rounded-md px-3 py-2" placeholder="Lifecycle Title" value={title} onChange={(e) => setTitle(e.target.value)} />
              <textarea className="border rounded-md px-3 py-2" placeholder="Lifecycle Description" value={description} onChange={(e) => setDescription(e.target.value)} rows={3} />
            </div>

            {/* Grouped, collapsible editor */}
            <div className="mt-2">
              {filterableGroups.map((fam) => (
                <details key={fam} className="border rounded-md mb-2" open>
                  <summary className="px-3 py-2 cursor-pointer bg-gray-50 font-medium">{fam}</summary>
                  <div className="p-3 space-y-2">
                    {nodes.filter((n) => n.Family === fam).map((n) => {
                      const active = activeNodeIds.has(n.NameID) || n.NameID === startNodeId;
                      return (
                        <details key={n.NameID} className="border rounded-md" open={n.NameID === startNodeId}>
                          <summary className="px-3 py-2 cursor-pointer flex items-center justify-between">
                            <span className="font-medium">{n.Name}</span>
                            <span className="text-xs text-gray-500">{active ? "Active" : "Inactive"}</span>
                          </summary>
                          <div className="p-3 space-y-2">
                            <label className="block text-sm text-gray-600">Node description (editable for this lifecycle)</label>
                            <textarea
                              disabled={!active}
                              className="w-full border rounded-md px-3 py-2 disabled:bg-gray-50"
                              defaultValue={n.Definition}
                            />

                            {/* Outgoing edges */}
                            <div className="mt-2 space-y-2">
                              <div className="text-sm font-medium">Outgoing edges</div>
                              {(outgoingBySource.get(n.NameID) || []).map((e) => {
                                const key = `${e.source}->${e.target}`;
                                const isOn = activeEdgeKeys.has(key);
                                const targetName = nodeById[e.target]?.Name || e.target;
                                const canEdit = (n.NameID === startNodeId) || activeNodeIds.has(n.NameID); // source must be active
                                return (
                                  <div key={key} className="border rounded-md p-2 flex flex-col gap-2">
                                    <label className="flex items-center gap-2">
                                      <input type="checkbox" disabled={!canEdit} checked={isOn} onChange={(ev) => setEdgeActive(e, ev.target.checked)} />
                                      <span className="text-sm">{n.Name} → {targetName}</span>
                                    </label>
                                    <input
                                      type="text"
                                      className="border rounded px-2 py-1"
                                      placeholder="Edge description (optional)"
                                      value={e.description || ""}
                                      onChange={(ev) => {
                                        // live-edit edge description in main edges array
                                        const val = ev.target.value;
                                        const idx = edges.findIndex((x) => x.source === e.source && x.target === e.target);
                                        if (idx >= 0) {
                                          const next = edges.slice();
                                          next[idx] = { ...next[idx], description: val };
                                          setEdges(next);
                                        }
                                      }}
                                    />
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </details>
                      );
                    })}
                  </div>
                </details>
              ))}
            </div>

            <div className="flex items-center gap-2">
              <button
                className="px-3 py-1.5 rounded-md border hover:bg-gray-50"
                onClick={() => {
                  const res = validateLifecycle();
                  if ((res as any).ok) {
                    alert("Lifecycle valid. You can now Save.");
                  } else {
                    alert("Validation failed:\n" + (res as any).errors.join("\n"));
                  }
                }}
              >
                Validate
              </button>
              <button
                className="px-3 py-1.5 rounded-md bg-indigo-600 text-white hover:bg-indigo-700 disabled:opacity-50"
                disabled={!(validateLifecycle() as any).ok}
                onClick={saveLifecycle}
              >
                Save Lifecycle
              </button>
            </div>
          </div>
        )}
      </aside>

      {/* Right Pane */}
      <section className="relative">
        {/* Controls */}
        <div className="absolute top-3 left-3 z-10 flex flex-col gap-2 bg-white/80 border rounded-lg p-3 shadow">
          <div className="text-xs font-semibold text-gray-600">View</div>
          <div className="flex gap-2">
            <button className="px-2 py-1 border rounded hover:bg-gray-50" onClick={zoomIn}>＋</button>
            <button className="px-2 py-1 border rounded hover:bg-gray-50" onClick={zoomOut}>－</button>
            <button className="px-2 py-1 border rounded hover:bg-gray-50" onClick={fit}>Fit</button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <button className="px-2 py-1 border rounded hover:bg-gray-50" onClick={() => pan(0, 80)}>↑</button>
            <div></div>
            <button className="px-2 py-1 border rounded hover:bg-gray-50" onClick={() => pan(0, -80)}>↓</button>
            <button className="px-2 py-1 border rounded hover:bg-gray-50" onClick={() => pan(80, 0)}>←</button>
            <div></div>
            <button className="px-2 py-1 border rounded hover:bg-gray-50" onClick={() => pan(-80, 0)}>→</button>
          </div>
        </div>

        {/* Filters */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-3 w-[min(420px,calc(100vw-24px))]">
          <div className="bg-white/80 border rounded-lg p-3 shadow">
            <div className="text-xs font-semibold text-gray-600 mb-2">Select by ID (Name)</div>
            <select
              className="w-full border rounded px-2 py-1"
              value={selectedName}
              onChange={(e) => {
                // switching modes resets others
                if (e.target.value) applySelectByName(e.target.value); else clearFilters();
              }}
            >
              <option value="">—</option>
              {filterableNodes.map((n) => (
                <option key={n.NameID} value={n.Name}>{n.Name}</option>
              ))}
            </select>
          </div>

          <div className="bg-white/80 border rounded-lg p-3 shadow">
            <div className="text-xs font-semibold text-gray-600 mb-2">Select by Group</div>
            <select
              className="w-full border rounded px-2 py-1"
              value={selectedGroup}
              onChange={(e) => {
                const val = e.target.value;
                if (val) applySelectByGroup(val); else clearFilters();
              }}
            >
              <option value="">—</option>
              {filterableGroups.map((g) => (
                <option key={g} value={g}>{g}</option>
              ))}
            </select>
          </div>

          <div className="bg-white/80 border rounded-lg p-3 shadow">
            <div className="text-xs font-semibold text-gray-600 mb-2">Legend</div>
            <div className="flex flex-wrap gap-2">
              {filterableGroups.map((fam) => {
                const active = filterMode === "legend" ? legendActive.has(fam) : true;
                return (
                  <button
                    key={fam}
                    onClick={() => toggleLegendFamily(fam)}
                    className={`px-2 py-1 rounded-full border text-sm ${active ? "bg-blue-600 text-white border-blue-700" : "bg-gray-100 text-gray-600"}`}
                  >
                    {fam}
                  </button>
                );
              })}
            </div>
            <div className="mt-3">
              <button className="px-3 py-1.5 rounded-md border hover:bg-gray-50" onClick={clearFilters}>Clear Filters</button>
            </div>
          </div>
        </div>

        {/* Graph canvas */}
        <div ref={containerRef} className="w-full h-[calc(100vh-0px)]" />
      </section>
    </div>
  );
}
