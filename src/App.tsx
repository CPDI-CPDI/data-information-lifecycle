// No default React import needed
import { useEffect, useMemo, useRef, useState } from "react";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";

// IMPORTANT: use type-only imports for types when verbatimModuleSyntax is on
import type { Node as VisNode, Edge as VisEdge } from "vis-network";
import { Network } from "vis-network";
import { DataSet } from "vis-data";

/**
 * Quick start notes (run these in your Codespace terminal):
 *
 *   npm install papaparse vis-network xlsx
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

// =================== HEX LAYOUT CONFIG ===================
const GAP_X = 180; // tweak freely
const GAP_Y = 140; // tweak freely

// Row counts for a 4-row hex tiling: 5, 4, 4, 4
// Horizontal offsets per row to make a hex grid: 0, +0.5, 0, +0.5
const HEX_ROWS = [
  { count: 5, offsetCols: 0 },
  { count: 4, offsetCols: 0 },
  { count: 4, offsetCols: 0.5 },
  { count: 4, offsetCols: 0 },
];

// Anchor names (case-insensitive) and which slot they take in the grid.
// Slots are defined row-by-row (r,c) with the offsets above.
// Using the diagram you gave: 5 on the top row, then 4, 4, 4.
const ANCHORS: Record<string, { r: number; c: number }> = {
  "specify needs": { r: 0, c: 0 }, // #1
  "discover":      { r: 0, c: 1 }, // #2
  "acquire":       { r: 1, c: 0 }, // #3
  "contextualize": { r: 2, c: 2 }, // #4 (third position in row 2)
  "share":         { r: 2, c: 3 }, // #5 (fourth in row 2)
  "preserve":      { r: 3, c: 2 }, // #6 (third in bottom row)
  "dispose":       { r: 3, c: 3 }, // #7 (fourth in bottom row)
};

// Build all grid “slots” (x,y) for the 5-4-4-4 hex rows.
function buildHexSlots(): Array<{ r: number; c: number; x: number; y: number }> {
  const slots: Array<{ r: number; c: number; x: number; y: number }> = [];
  for (let r = 0; r < HEX_ROWS.length; r++) {
    const { count, offsetCols } = HEX_ROWS[r];
    // center rows around 0; apply half-column offset for hex effect
    const colStart = -((count - 1) / 2);
    for (let c = 0; c < count; c++) {
      const cx = (colStart + c + offsetCols) * GAP_X;
      const cy = (r - (HEX_ROWS.length - 1) / 2) * GAP_Y;
      slots.push({ r, c, x: cx, y: cy });
    }
  }
  return slots;
}

// Assign fixed hex positions:
// - place anchors first
// - fill remaining slots with other nodes (stable order, loosely by Family then Name)
function computeFixedHexPositions(nodes: NodeRow[]): Record<string, { x: number; y: number }> {
  const slots = buildHexSlots();
  const posBySlotKey = new Map<string, { x: number; y: number }>();
  for (const s of slots) posBySlotKey.set(`${s.r}:${s.c}`, { x: s.x, y: s.y });

  // map Name -> row slot (case-insensitive)
  const nameToSlot = new Map<string, { r: number; c: number }>();
  for (const [name, slot] of Object.entries(ANCHORS)) {
    nameToSlot.set(name, slot);
  }

  // 1) put anchors
  const usedSlots = new Set<string>();
  const positions: Record<string, { x: number; y: number }> = {};
  const byNameLower = Object.fromEntries(nodes.map(n => [n.Name.toLowerCase(), n]));

  for (const [lowerName, slot] of nameToSlot) {
    const n = byNameLower[lowerName];
    if (!n) continue; // anchor node absent → skip gracefully
    const key = `${slot.r}:${slot.c}`;
    const p = posBySlotKey.get(key);
    if (!p) continue;
    positions[n.NameID] = { x: p.x, y: p.y };
    usedSlots.add(key);
  }

  // 2) fill the remaining slots with remaining nodes (group by Family then Name)
  const remainingNodes = nodes
    .filter(n => positions[n.NameID] === undefined)
    .sort((a, b) => {
      const fa = a.Family || "", fb = b.Family || "";
      if (fa !== fb) return fa.localeCompare(fb);
      return (a.Name || "").localeCompare(b.Name || "");
    });

  for (const s of slots) {
    const key = `${s.r}:${s.c}`;
    if (usedSlots.has(key)) continue;
    const n = remainingNodes.shift();
    if (!n) break;
    positions[n.NameID] = { x: s.x, y: s.y };
  }

  return positions;
}

// If an edge goes A→C and there is a node B exactly between them on the same row,
// curve the edge slightly to avoid visually “piercing” B.
function applyAntiPierce(
  visEdges: DataSet<VisEdge>,
  positions: Record<string, { x: number; y: number }>,
  nodes: NodeRow[]
) {
  const all = visEdges.get();
  const updates: Array<Partial<VisEdge> & { id: string | number }> = [];

  // Build row membership by Y (within small epsilon)
  const eps = 1e-3;
  const yBuckets = new Map<number, string[]>(); // y -> NameIDs
  for (const id of Object.keys(positions)) {
    const y = positions[id].y;
    // quantize Y to avoid float noise
    const key = Math.round(y * 1000) / 1000;
    if (!yBuckets.has(key)) yBuckets.set(key, []);
    yBuckets.get(key)!.push(id);
  }

  // Helper: is idB between idA and idC on the same row?
  function hasMiddleOnSameRow(idA: string, idC: string): boolean {
    const pA = positions[idA], pC = positions[idC];
    if (!pA || !pC) return false;
    const yKey = Math.round(pA.y * 1000) / 1000;
    if (Math.abs(pA.y - pC.y) > eps) return false; // not same row
    const row = yBuckets.get(yKey) || [];
    const [xmin, xmax] = pA.x < pC.x ? [pA.x, pC.x] : [pC.x, pA.x];
    return row.some(mid => {
      if (mid === idA || mid === idC) return false;
      const x = positions[mid].x;
      return x > xmin + eps && x < xmax - eps;
    });
  }

  for (const e of all) {
    const from = String(e.from);
    const to   = String(e.to);
    const pierces = hasMiddleOnSameRow(from, to);
    if (pierces) {
      updates.push({
        id: e.id!,
        smooth: { enabled: true, type: "curvedCW", roundness: 0.15 } as any
      });
    } else {
      updates.push({
        id: e.id!,
        smooth: { enabled: false } as any
      });
    }
  }

  if (updates.length) visEdges.update(updates);
}


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

// Merge tooltips by undirected pair (A<->B shows both directions in one tooltip)
function buildVisDatasets(
  nodes: NodeRow[],
  edges: EdgeRow[],
  options: {
    positions?: Record<string, { x: number; y: number }> | null;
    showEdgeTooltips?: boolean;
    activeNodeIds?: Set<string> | null;
  } = {}
) {
  const nodeMapById: Record<string, NodeRow> = Object.fromEntries(nodes.map(n => [n.NameID, n]));

  // family colors (stable + consistent)
  const famColor = (family: string) => makeColorForFamily(family);
  const famCache: Record<string, ReturnType<typeof makeColorForFamily>> = {};

  const visNodes = new DataSet<VisNode>(
    nodes.map((n) => {
      if (!famCache[n.Family]) famCache[n.Family] = famColor(n.Family);
      const c = famCache[n.Family];
      const isActive = options.activeNodeIds ? options.activeNodeIds.has(n.NameID) : true;
      const pos = options.positions?.[n.NameID];
      const size = Math.min(24, Math.max(12, Number(n.size ?? 16)));

      return {
        id: n.NameID,
        label: n.Name,
        title: n.Definition || n.Name,
        group: n.Family,
        shape: "dot",
        size,
        ...(pos ? { x: pos.x, y: pos.y, fixed: { x: true, y: true } } : {}),
        color: isActive
          ? { border: c.border, background: c.background, highlight: c.highlight }
          : { border: "#cccccc", background: "#e5e7eb", highlight: { border: "#a1a1aa", background: "#e5e7eb" } },
        font: { color: isActive ? "#111827" : "#9ca3af", face: "ui-sans-serif, system-ui" }
      } as VisNode;
    })
  );

  // Merge tooltips for bi-directional pairs (one tooltip shows both directions)
  const pairKey = (a: string, b: string) => (a < b ? `${a}__${b}` : `${b}__${a}`);
  const tipLines = new Map<string, string[]>();
  for (const e of edges) {
    const s = nodeMapById[e.source]?.Name || e.source;
    const t = nodeMapById[e.target]?.Name || e.target;
    const d = (e.description || "No description").trim();
    const pk = pairKey(e.source, e.target);
    if (!tipLines.has(pk)) tipLines.set(pk, []);
    tipLines.get(pk)!.push(`${s} → ${t}: ${d}`);
  }

  const visEdges = new DataSet<VisEdge>(
    edges.map((e) => {
      const src = nodeMapById[e.source];
      const c = src ? makeColorForFamily(src.Family) : { border: "#1f2937", highlight: { border: "#1f2937", background: "#1f2937" } };
      const pk = pairKey(e.source, e.target);
      const title = options.showEdgeTooltips ? (tipLines.get(pk) || []).join("\n") : undefined;

      return {
        id: e.id,
        from: e.source,
        to: e.target,
        arrows: "to",
        smooth: { enabled: false } as any,
        width: 1.5,
        color: { color: c.border, highlight: c.highlight.border },
        title
      } as VisEdge;
    })
  );

  return { visNodes, visEdges };
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

  const activeFilterLabel = useMemo(() => {
    if (filterMode === "id" && selectedName) {
      return `Filter: ${selectedName}`;
    }
    if (filterMode === "group" && selectedGroup) {
      return `Filter: ${selectedGroup} (group)`;
    }
    if (filterMode === "legend") {
      const fams = Array.from(legendActive);
      if (fams.length === 1) {
        return `Filter: ${fams[0]} (legend)`;
      } else if (fams.length > 1) {
        return `Filter: ${fams.slice(0, 2).join(", ")}${fams.length > 2 ? "…" : ""} (legend)`;
      }
    }
    return null;
  }, [filterMode, selectedName, selectedGroup, legendActive]);

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

  // Build / rebuild Network with ALL-HEX positions (static)
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    // 1) compute fixed hex positions
    const positions = computeFixedHexPositions(nodes);

    // 2) build datasets with those positions + tooltips in lifecycle modes
    const { visNodes, visEdges } = buildVisDatasets(nodes, edges, {
      positions,
      showEdgeTooltips: lifecycleMode !== "none",
      activeNodeIds: lifecycleMode !== "none" ? activeNodeIds : null
    });

    visNodesRef.current = visNodes;
    visEdgesRef.current = visEdges;

    // 3) static network (physics OFF; nodes fixed)
    const net = new Network(
      containerRef.current,
      { nodes: visNodes, edges: visEdges },
      {
        autoResize: true,
        physics: { enabled: false },
        interaction: {
          hover: true,
          tooltipDelay: 120,
          multiselect: false,
          dragNodes: false, // KEEP static
          dragView: true,
          zoomView: true,
          selectConnectedEdges: false
        },
        layout: { improvedLayout: false }, // we supply positions
        edges: { arrows: { to: { enabled: true, scaleFactor: 0.8 } }, width: 1.5 }
      }
    );

    // 4) small “anti-pierce” curvature on horizontal three-in-a-row cases
    applyAntiPierce(visEdges, positions, nodes);
    net.redraw();

    // 5) frame it nicely in view
    setTimeout(() => net.fit({ animation: { duration: 450, easingFunction: "easeInOutQuad" } }), 30);

    networkRef.current = net;
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
    if (visNodesRef.current && visEdgesRef.current) {
      clearDimStyles(visNodesRef.current, visEdgesRef.current);
    }
  }

  function applySelectByName(name: string) {
    setFilterMode("id");
    setSelectedName(name);
    setSelectedGroup("");
    setLegendActive(new Set(groups));

    if (!visNodesRef.current || !visEdgesRef.current) return;
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

    if (!visNodesRef.current || !visEdgesRef.current) return;
    const visNodes = visNodesRef.current;
    const visEdges = visEdgesRef.current;

    const groupNodeIds = new Set(nodes.filter((n) => n.Family === group).map((n) => n.NameID));
    const keepNodes = new Set<string>(groupNodeIds);
    const keepEdges = new Set<string>();

    for (const e of visEdges.get()) {
      const from = String(e.from);
      const to = String(e.to);
      if (groupNodeIds.has(from)) {
        keepEdges.add(String(e.id));
        keepNodes.add(to);
      }
    }
    applyDimStyles(visNodes, visEdges, keepNodes, keepEdges);
  }

  function toggleLegendFamily(fam: string) {
    if (!visNodesRef.current || !visEdgesRef.current) return;

    // determine next set
    let nextActive: Set<string>;
    if (filterMode !== "legend") {
      nextActive = new Set([fam]); // isolate-on-first-click
    } else {
      nextActive = new Set(legendActive);
      if (nextActive.has(fam)) nextActive.delete(fam); else nextActive.add(fam);
      if (nextActive.size === 0) nextActive.add(fam); // avoid empty
    }

    // compute brightness sets
    const visNodes = visNodesRef.current;
    const visEdges = visEdgesRef.current;

    const keepNodes = new Set(nodes.filter((n) => nextActive.has(n.Family)).map((n) => n.NameID));
    const keepEdges = new Set<string>();
    for (const e of visEdges.get()) {
      const from = String(e.from);
      const to = String(e.to);
      if (keepNodes.has(from)) {
        keepEdges.add(String(e.id));
        keepNodes.add(to);
      }
    }

    applyDimStyles(visNodes, visEdges, keepNodes, keepEdges);

    setFilterMode("legend");
    setSelectedName("");
    setSelectedGroup("");
    setLegendActive(nextActive);
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
  function getLifecycleErrors(): string[] {
    const errs: string[] = [];

    if (!title.trim()) errs.push("A Title is required.");
    if (!description.trim()) errs.push("A Description is required.");

    if (!startNodeId) errs.push("The required start node 'Specify needs' was not found in the master node list.");
    if (!disposeId) errs.push("The required end node 'Dispose' was not found in the master node list.");
    if (!startNodeId || !disposeId) return errs;

    const reachable = bfsReachable(startNodeId, activeEdgeKeys);
    if (!reachable.has(disposeId)) errs.push("Your path must allow 'Dispose' to be reachable from 'Specify needs'.");

    // terminals = reachable nodes with no outgoing active edges
    const terminals = Array.from(reachable).filter((nodeId) => {
      return !Array.from(activeEdgeKeys).some((key) => key.startsWith(nodeId + "->"));
    });
    for (const termId of terminals) {
      const isDispose = termId === disposeId;
      const isShare = termId === shareId;
      if (!isDispose && !isShare) {
        const nodeName = nodeById[termId]?.Name || termId;
        errs.push(`The node '${nodeName}' is currently an end point in your flow, but only 'Dispose' or 'Share' can end a branch.`);
      }
    }

    // unreachable sources
    for (const key of activeEdgeKeys) {
      const [src] = key.split("->");
      if (!reachable.has(src)) {
        const srcName = nodeById[src]?.Name || src;
        errs.push(`You activated an edge from '${srcName}', but '${srcName}' is not reachable from 'Specify needs'.`);
      }
    }

    return errs;
  }

  function saveLifecycle() {
    const errs = getLifecycleErrors();
    if (errs.length > 0) {
      alert("Cannot save. Please fix the following:\n\n" + errs.join("\n"));
      return;
    }

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
      const problems: string[] = [];

      for (const n of inNodes) {
        const id = n?.NameID;
        if (!id || !nodeIds.has(id)) problems.push(`Nodes sheet: NameID '${id || "(missing)"}' not found in All Nodes`);
      }
      for (const e of inEdges) {
        const key = `${e.source}->${e.target}`;
        if (!edgePairs.has(key)) problems.push(`Edges sheet: pair '${key}' not found in All Edges`);
      }
      if (problems.length) {
        alert("Import failed:\n" + problems.join("\n"));
        return;
      }

      // Load into editor
      setLifecycleMode("edit");
      setTitle(t);
      setDescription(d);
      const next = new Set<string>();
      for (const e of inEdges) if (e.source && e.target) next.add(`${e.source}->${e.target}`);
      setActiveEdgeKeys(next);

      // Merge any edge descriptions
      const merged = edges.slice();
      for (const imp of inEdges) {
        if (!imp.source || !imp.target) continue;
        const idx = merged.findIndex((x) => x.source === imp.source && x.target === imp.target);
        if (idx >= 0) merged[idx] = { ...merged[idx], description: imp.description ?? merged[idx].description };
      }
      setEdges(merged);
    } catch (err: any) {
      alert("Failed to load lifecycle: " + (err?.message || "Unknown error"));
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
              <button onClick={startLifecycleCreate} className="px-3 py-1.5 rounded-md bg-black text-white">Start Custom Lifecycle</button>
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
                <details
                  key={fam}
                  className="border rounded-md mb-2 bg-white shadow-sm"
                  open
                >
                  <summary className="px-3 py-2 cursor-pointer bg-gray-100 font-medium text-sm flex items-center justify-between">
                    <span>{fam}</span>
                  </summary>

                  <div className="p-3 space-y-3">
                    {nodes
                      .filter((n) => n.Family === fam)
                      .map((n) => {
                        const isNodeActive =
                          activeNodeIds.has(n.NameID) || n.NameID === startNodeId;

                        return (
                          <details
                            key={n.NameID}
                            className={`border rounded-md shadow-sm ${
                              isNodeActive ? "bg-white" : "bg-gray-50 opacity-60"
                            }`}
                            open={n.NameID === startNodeId}
                          >
                            <summary className="px-3 py-2 cursor-pointer flex items-center justify-between">
                              <span className="font-medium text-sm">{n.Name}</span>

                              <span
                                className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                                  isNodeActive
                                    ? "bg-emerald-600 text-white"
                                    : "bg-gray-400 text-white"
                                }`}
                              >
                                {isNodeActive ? "Active" : "Inactive"}
                              </span>
                            </summary>

                            <div className="p-3 space-y-3">
                              {/* Node description editor */}
                              <div>
                                <label className="block text-xs text-gray-600 mb-1">
                                  Node description (editable for this lifecycle)
                                </label>
                                <textarea
                                  disabled={!isNodeActive}
                                  className="w-full border rounded-md px-3 py-2 disabled:bg-gray-100 disabled:text-gray-500 text-sm focus:outline-none focus:ring-2 focus:ring-black"
                                  defaultValue={n.Definition}
                                />
                              </div>

                              {/* Outgoing edges */}
                              <div className="space-y-2">
                                <div className="text-xs font-semibold text-gray-700">
                                  Outgoing edges
                                </div>

                                {(outgoingBySource.get(n.NameID) || []).map((e) => {
                                  const key = `${e.source}->${e.target}`;
                                  const isEdgeOn = activeEdgeKeys.has(key);
                                  const targetName =
                                    nodeById[e.target]?.Name || e.target;

                                  // can only toggle edges from active nodes
                                  const canEditThisEdge =
                                    n.NameID === startNodeId ||
                                    activeNodeIds.has(n.NameID);

                                  return (
                                    <div
                                      key={key}
                                      className={`border rounded-md p-2 flex flex-col gap-2 text-sm shadow-sm ${
                                        canEditThisEdge ? "bg-white" : "bg-gray-100"
                                      }`}
                                    >
                                      <label className="flex items-center gap-2">
                                        <input
                                          type="checkbox"
                                          disabled={!canEditThisEdge}
                                          checked={isEdgeOn}
                                          onChange={(ev) =>
                                            setEdgeActive(e, ev.target.checked)
                                          }
                                        />
                                        <span className="text-sm">
                                          {n.Name} → {targetName}
                                        </span>
                                      </label>

                                      <input
                                        type="text"
                                        className="border rounded px-2 py-1 text-xs disabled:bg-gray-100 disabled:text-gray-500 focus:outline-none focus:ring-2 focus:ring-black"
                                        placeholder="Edge description (optional)"
                                        value={e.description || ""}
                                        onChange={(ev) => {
                                          const val = ev.target.value;
                                          const idx = edges.findIndex(
                                            (x) =>
                                              x.source === e.source &&
                                              x.target === e.target
                                          );
                                          if (idx >= 0) {
                                            const next = edges.slice();
                                            next[idx] = {
                                              ...next[idx],
                                              description: val,
                                            };
                                            setEdges(next);
                                          }
                                        }}
                                        disabled={!canEditThisEdge}
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
                className="px-3 py-1.5 rounded-md bg-black text-white"
                onClick={() => {
                  const errs = getLifecycleErrors();
                  if (errs.length === 0) {
                    alert("Lifecycle valid. You can now Save.");
                  } else {
                    alert("Validation failed:\n\n" + errs.join("\n"));
                  }
                }}
              >
                Validate
              </button>
              <button
                className="px-3 py-1.5 rounded-md bg-black text-white disabled:opacity-50"
                disabled={getLifecycleErrors().length > 0}
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
            <button className="px-2 py-1 rounded bg-black text-white" onClick={zoomIn}>＋</button>
            <button className="px-2 py-1 rounded bg-black text-white" onClick={zoomOut}>－</button>
            <button className="px-2 py-1 rounded bg-black text-white" onClick={fit}>Fit</button>
          </div>
          <div className="grid grid-cols-3 gap-1">
            <button className="px-2 py-1 rounded bg-black text-white" onClick={() => pan(0, 80)}>↑</button>
            <div></div>
            <button className="px-2 py-1 rounded bg-black text-white" onClick={() => pan(0, -80)}>↓</button>
            <button className="px-2 py-1 rounded bg-black text-white" onClick={() => pan(80, 0)}>←</button>
            <div></div>
            <button className="px-2 py-1 rounded bg-black text-white" onClick={() => pan(-80, 0)}>→</button>
          </div>
        </div>

        {/* Filters */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-3 w-[min(210px,calc(100vw-48px))]">
          {activeFilterLabel && (
            <div className="bg-white/80 border rounded-lg p-2 shadow">
              <div className="text-[10px] font-semibold text-gray-800 leading-tight break-words max-h-32 overflow-y-auto">
                {activeFilterLabel}
              </div>
            </div>
          )}

          <div className="bg-white/80 border rounded-lg p-3 shadow">
            <div className="text-xs font-semibold text-gray-600 mb-2">Select by Name</div>
            <select
              className="w-full border rounded px-2 py-1"
              value={selectedName}
              onChange={(e) => {
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
              <button className="px-3 py-1.5 rounded-md bg-black text-white" onClick={clearFilters}>Clear Filters</button>
            </div>
          </div>
        </div>

        {/* Graph canvas */}
        <div ref={containerRef} className="w-full h-[calc(100vh-0px)]" />
      </section>
    </div>
  );
}
