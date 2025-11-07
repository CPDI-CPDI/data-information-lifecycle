// No default React import needed
import { useEffect, useMemo, useRef, useState } from "react";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";

// IMPORTANT: type-only imports for vis-network types
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
  size?: string | number;
  [k: string]: any;
};

export type EdgeRow = {
  id: string | number;
  source: string; // NameID
  target: string; // NameID
  group?: string; // FamilyID(source)
  description?: string;
  [k: string]: any;
};

// =================== HEX LAYOUT CONFIG ===================
const GAP_X = 180; // tweak freely
const GAP_Y = 140; // tweak freely

// Row counts 5,4,4,4. Offsets provide the staggered hex pattern.
const HEX_ROWS = [
  { count: 5, offsetCols: 0 },
  { count: 4, offsetCols: 0 },
  { count: 4, offsetCols: 0.5 },
  { count: 4, offsetCols: 0 },
];

// Anchor names (case-insensitive) → slots (row, col)
const ANCHORS: Record<string, { r: number; c: number }> = {
  "specify needs": { r: 0, c: 0 },
  discover: { r: 0, c: 1 },
  acquire: { r: 1, c: 0 },
  contextualize: { r: 2, c: 2 },
  share: { r: 2, c: 3 },
  preserve: { r: 3, c: 2 },
  dispose: { r: 3, c: 3 },
};

const padLabel = (s: string) => `\u2007${s}\u2007`; // figure spaces ≈ 2px each side at this size

// ── THEME HELPERS ─────────────────────────────────────────────
function usePrefersDark() {
  const get = () =>
    typeof window !== "undefined" &&
    window.matchMedia?.("(prefers-color-scheme: dark)").matches;

  const [isDark, setIsDark] = useState<boolean>(get());

  useEffect(() => {
    const mq = window.matchMedia?.("(prefers-color-scheme: dark)");
    if (!mq) return;
    const onChange = (e: MediaQueryListEvent) => setIsDark(e.matches);
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);

  return isDark;
}

function makeUiClasses(isDark: boolean) {
  const panel = isDark
    ? "bg-neutral-900/85 text-white border border-neutral-700"
    : "bg-white/90 text-black border border-neutral-200";

  const panelTitle = isDark
    ? "text-xs font-semibold text-neutral-200 mb-2"
    : "text-xs font-semibold text-neutral-700 mb-2";

  // Buttons
  const btnPill = isDark
    ? "rounded-md bg-black text-white border border-neutral-700 hover:opacity-90"
    : "rounded-md bg-white text-black border border-neutral-300 hover:bg-neutral-50";

  // Legend chips — forced high contrast per theme
  const chipActive = isDark
    ? "!bg-black !text-white !border-neutral-700 hover:opacity-90"
    : "!bg-white !text-black !border-neutral-300 hover:bg-neutral-50";

  const chipInactive = isDark
    ? "!bg-black/80 !text-white/80 !border-neutral-700 hover:bg-black"
    : "!bg-white !text-black/70 !border-neutral-300 hover:bg-neutral-50";

  const divider = isDark ? "border-neutral-700" : "border-neutral-200";
  const asideBg = isDark ? "bg-neutral-950 text-white" : "bg-white text-black";
  const subtle = isDark ? "text-neutral-300" : "text-neutral-600";

  const input =
    "w-full rounded px-2 py-1 outline-none focus:ring-2 focus:ring-black transition";
  const inputTheme = isDark
    ? "bg-neutral-800 text-white border border-neutral-600 placeholder-neutral-400"
    : "bg-white text-black border border-neutral-300 placeholder-neutral-500";

  return {
    panel,
    panelTitle,
    btnPill,
    chipActive,
    chipInactive,
    divider,
    asideBg,
    subtle,
    input: `${input} ${inputTheme}`,
  };
}

function buildHexSlots(): Array<{ r: number; c: number; x: number; y: number }> {
  const slots: Array<{ r: number; c: number; x: number; y: number }> = [];
  for (let r = 0; r < HEX_ROWS.length; r++) {
    const { count, offsetCols } = HEX_ROWS[r];
    const colStart = -((count - 1) / 2);
    for (let c = 0; c < count; c++) {
      const cx = (colStart + c + offsetCols) * GAP_X;
      const cy = (r - (HEX_ROWS.length - 1) / 2) * GAP_Y;
      slots.push({ r, c, x: cx, y: cy });
    }
  }
  return slots;
}

function computeFixedHexPositions(nodes: NodeRow[]): Record<string, { x: number; y: number }> {
  const slots = buildHexSlots();
  const posBySlotKey = new Map<string, { x: number; y: number }>();
  for (const s of slots) posBySlotKey.set(`${s.r}:${s.c}`, { x: s.x, y: s.y });

  const nameToSlot = new Map<string, { r: number; c: number }>();
  for (const [name, slot] of Object.entries(ANCHORS)) nameToSlot.set(name, slot);

  const usedSlots = new Set<string>();
  const positions: Record<string, { x: number; y: number }> = {};
  const byNameLower = Object.fromEntries(nodes.map((n) => [n.Name.toLowerCase(), n]));

  // Place anchors
  for (const [lowerName, slot] of nameToSlot) {
    const n = byNameLower[lowerName];
    if (!n) continue;
    const key = `${slot.r}:${slot.c}`;
    const p = posBySlotKey.get(key);
    if (!p) continue;
    positions[n.NameID] = { x: p.x, y: p.y };
    usedSlots.add(key);
  }

  // Fill remaining slots grouped (Family then Name)
  const remaining = nodes
    .filter((n) => positions[n.NameID] === undefined)
    .sort((a, b) => (a.Family || "").localeCompare(b.Family || "") || (a.Name || "").localeCompare(b.Name || ""));

  for (const s of slots) {
    const key = `${s.r}:${s.c}`;
    if (usedSlots.has(key)) continue;
    const n = remaining.shift();
    if (!n) break;
    positions[n.NameID] = { x: s.x, y: s.y };
  }

  return positions;
}

// ----- Anti-pierce (curves edges that pass too close to another node) -----
function applyAntiPierce(visEdges: DataSet<VisEdge>, positions: Record<string, { x: number; y: number }>) {
  const edges = visEdges.get();
  const nodeIds = Object.keys(positions);

  // approximate node radius (px)
  const HIT_R = 18;
  const PADDING = 6;
  const THRESH = HIT_R + PADDING;

  function distPointToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const abx = bx - ax,
      aby = by - ay;
    const apx = px - ax,
      apy = py - ay;
    const ab2 = abx * abx + aby * aby || 1;
    let t = (apx * abx + apy * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * abx,
      qy = ay + t * aby;
    return Math.hypot(px - qx, py - qy);
  }

  const updates: Array<Partial<VisEdge> & { id: string | number }> = [];

  for (const e of edges) {
    const from = String(e.from);
    const to = String(e.to);
    const A = positions[from];
    const B = positions[to];
    if (!A || !B) continue;

    let pierces = false;
    for (const nid of nodeIds) {
      if (nid === from || nid === to) continue;
      const P = positions[nid];
      const d = distPointToSeg(P.x, P.y, A.x, A.y, B.x, B.y);
      if (d < THRESH) {
        pierces = true;
        break;
      }
    }

    if (pierces) {
      const vx = B.x - A.x,
        vy = B.y - A.y;
      const mx = (A.x + B.x) / 2,
        my = (A.y + B.y) / 2;
      const cross = vx * (my - A.y) - vy * (mx - A.x);
      updates.push({
        id: e.id!,
        smooth: { enabled: true, type: cross >= 0 ? "curvedCW" : "curvedCCW", roundness: 0.2 } as any,
      });
    } else {
      updates.push({ id: e.id!, smooth: { enabled: false } as any });
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

  const parsed = Papa.parse(text, { header: true, skipEmptyLines: true }) as unknown as CsvResult<T>;
  return (parsed.data ?? []).filter((row) => row && typeof row === "object" && Object.keys(row as object).length > 0);
}

// ----- Family palette (matches your legend) -----
function makeColorForFamily(
  family: string
): { border: string; background: string; highlight: { border: string; background: string } } {
  const PALETTE: Record<string, { bg: string; border: string; hiBg?: string; hiBorder?: string }> = {
    INITIATION: { bg: "#A7C6ED", border: "#3B82F6" }, // blue-ish
    ACQUISITION: { bg: "#FFE866", border: "#F59E0B" }, // yellow
    CONFIGURATION: { bg: "#FF9AA2", border: "#DC2626" }, // red
    PROCESSING: { bg: "#A7E07A", border: "#16A34A" }, // green
    LEVERAGING: { bg: "#F1A7FF", border: "#A21CAF" }, // magenta
    DISPOSITION: { bg: "#C4B5FD", border: "#7C3AED" }, // purple

    // Long display names (if your CSV uses these)
    "Plan, design & enable": { bg: "#A7C6ED", border: "#3B82F6" },
    "Archive transfer & destroy": { bg: "#C4B5FD", border: "#7C3AED" },
    "Create, Capture & Collect": { bg: "#FFE866", border: "#F59E0B" },
    "Organize, store & maintain": { bg: "#FF9AA2", border: "#DC2626" },
    "Provision, integrate & Curate": { bg: "#A7E07A", border: "#16A34A" },
    "Access, use & share": { bg: "#F1A7FF", border: "#A21CAF" },
  };

  const defined = PALETTE[family];
  if (defined) {
    return {
      border: defined.border,
      background: defined.bg,
      highlight: {
        border: defined.hiBorder ?? defined.border,
        background: defined.hiBg ?? defined.bg,
      },
    };
  }

  // Fallback deterministic pastel
  let h = 0;
  for (let i = 0; i < family.length; i++) h = (h * 31 + family.charCodeAt(i)) >>> 0;
  const hue = h % 360;
  const sat = 55,
    light = 72;
  const color = `hsl(${hue} ${sat}% ${light}%)`;
  const border = `hsl(${hue} ${sat + 10}% ${Math.max(35, light - 25)}%)`;
  const hiBg = `hsl(${hue} ${sat + 5}% ${Math.min(92, light + 15)}%)`;
  const hiBorder = `hsl(${hue} ${sat + 15}% ${Math.max(30, light - 30)}%)`;
  return { border, background: color, highlight: { border: hiBorder, background: hiBg } };
}

// -----------------------------
// Graph + Filtering logic
// -----------------------------
type FilterMode = null | "id" | "group" | "legend";

// Reversible dimming using stored originals on each item
function applyDimStyles(
  visNodes: DataSet<VisNode>,
  visEdges: DataSet<VisEdge>,
  keepNodeIds: Set<string>,
  keepEdgeIds: Set<string>
) {
  const nodeUpdates: any[] = [];
  for (const n of visNodes.get()) {
    const keep = keepNodeIds.has(String(n.id));
    nodeUpdates.push({
      id: n.id as any,
      opacity: keep ? 1.0 : 0.25,
      font: keep
        ? (n as any).__origFont
        : { ...(n as any).__origFont, color: "#9ca3af", background: "#000000" },
      color: (n as any).__origColor,
    });
  }

  const edgeUpdates: any[] = [];
  for (const e of visEdges.get()) {
    const keep = keepEdgeIds.has(String(e.id));
    edgeUpdates.push({
      id: e.id as any,
      color: keep ? (e as any).__origColor : { color: "#d1d5db" },
      width: (e as any).__origWidth,
    });
  }

  if (nodeUpdates.length) visNodes.update(nodeUpdates);
  if (edgeUpdates.length) visEdges.update(edgeUpdates);
}

function clearDimStyles(
  visNodes: DataSet<VisNode>,
  visEdges: DataSet<VisEdge>,
  origNodeStyles: Map<string, { color: any; font: any; opacity?: number }>,
  origEdgeStyles: Map<string, { color: any; width?: number }>
) {
  const nodeUpdates: any[] = [];
  for (const n of visNodes.get()) {
    const id = String(n.id);
    const orig = origNodeStyles.get(id);
    nodeUpdates.push({
      id,
      opacity: orig?.opacity ?? 1.0,
      font: orig?.font ?? (n as any).__origFont ?? { color: "#111827" },
      color: orig?.color ?? (n as any).__origColor ?? (n as any).color,
    });
  }

  const edgeUpdates: any[] = [];
  for (const e of visEdges.get()) {
    const id = String(e.id);
    const orig = origEdgeStyles.get(id);
    edgeUpdates.push({
      id,
      color: orig?.color ?? (e as any).__origColor ?? (e as any).color,
      width: orig?.width ?? (e as any).__origWidth ?? (e as any).width,
    });
  }

  if (nodeUpdates.length) visNodes.update(nodeUpdates);
  if (edgeUpdates.length) visEdges.update(edgeUpdates);
}

// BFS for lifecycle “active” nodes
function bfsReachable(start: string, edgesSet: Set<string>): Set<string> {
  const q: string[] = start ? [start] : [];
  const seen = new Set<string>(start ? [start] : []);
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

// Build DataSets with per-item original styles + merged tooltips
function buildVisDatasets(
  nodes: NodeRow[],
  edges: EdgeRow[],
  options: {
    positions?: Record<string, { x: number; y: number }> | null;
    showEdgeTooltips?: boolean;
    activeNodeIds?: Set<string> | null;
  } = {}
) {
  const nodeMapById: Record<string, NodeRow> = Object.fromEntries(nodes.map((n) => [n.NameID, n]));
  const famCache: Record<string, ReturnType<typeof makeColorForFamily>> = {};

  // Merge pair tooltips
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

  const visNodes = new DataSet<VisNode>(
    nodes.map((n) => {
      if (!famCache[n.Family]) famCache[n.Family] = makeColorForFamily(n.Family);
      const c = famCache[n.Family];
      const isActive = options.activeNodeIds ? options.activeNodeIds.has(n.NameID) : true;
      const pos = options.positions?.[n.NameID];
      const size = Math.min(24, Math.max(12, Number(n.size ?? 16)));

      const node: any = {
        id: n.NameID,
        label: padLabel(n.Name),
        title: n.Definition || n.Name,
        group: n.Family,
        shape: "dot",
        size,
        font: {
          color: isActive ? "#ffffff" : "#9ca3af",
          background: "#000000",
          vadjust: -2,
          face: "ui-sans-serif, system-ui",
        },
        color: isActive
          ? { border: c.border, background: c.background, highlight: c.highlight }
          : { border: "#cccccc", background: "#e5e7eb", highlight: { border: "#a1a1aa", background: "#e5e7eb" } },
      };

      if (pos) {
        node.x = pos.x;
        node.y = pos.y;
        node.fixed = { x: true, y: true };
      }

      node.__origColor = node.color;
      node.__origFont = node.font;
      node.__origOpacity = 1.0;

      return node as VisNode;
    })
  );

  const visEdges = new DataSet<VisEdge>(
    edges.map((e) => {
      const src = nodeMapById[e.source];
      const familyColor = src
        ? makeColorForFamily(src.Family)
        : { border: "#1f2937", highlight: { border: "#1f2937", background: "#1f2937" } };
      const pk = pairKey(e.source, e.target);

      const edge: any = {
        id: e.id,
        from: e.source,
        to: e.target,
        arrows: "to",
        smooth: { enabled: false } as any,
        width: 1.5,
        color: { color: familyColor.border, highlight: familyColor.highlight.border },
        title: options.showEdgeTooltips ? (tipLines.get(pk) || []).join("\n") : undefined,
      };

      edge.__origColor = edge.color;
      edge.__origWidth = edge.width;
      return edge as VisEdge;
    })
  );

  return { visNodes, visEdges };
}

// ---------- App state persistence & sharing ----------
type AppPersist = {
  lifecycleMode: "none" | "create" | "edit";
  title: string;
  description: string;
  activeEdgeKeys: string[];
  filterMode: FilterMode;
  selectedName: string;
  selectedGroup: string;
  legendActive: string[];
  edgeDescriptions: Array<{ source: string; target: string; description?: string }>;
};

const LS_KEY = "lifecycle_builder_state_v1";

function base64UrlEncode(s: string): string {
  const b64 = btoa(unescape(encodeURIComponent(s)));
  return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function base64UrlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4);
  return decodeURIComponent(escape(atob(b64)));
}

// -----------------------------
// GLOBAL hold-to-repeat controller
// -----------------------------
let __holdTimer: any = null;
function beginHold(action: () => void) {
  stopHold();
  action();
  __holdTimer = setInterval(action, 16);
}
function stopHold() {
  if (__holdTimer) {
    clearInterval(__holdTimer);
    __holdTimer = null;
  }
}

// ✅ Pan step doubled (was 1)
const PAN_STEP = 2;

// -----------------------------
// Main Component
// -----------------------------
export default function App() {
  const base = import.meta.env.BASE_URL || "/";

  const isDark = usePrefersDark();
  const ui = makeUiClasses(isDark);

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

  // NEW: for triggering the Edit button's file chooser
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importJsonRef = useRef<HTMLInputElement | null>(null);

  // Originals (for reliable Clear Filters)
  const origNodeStylesRef = useRef<Map<string, { color: any; font: any; opacity?: number }>>(new Map());
  const origEdgeStylesRef = useRef<Map<string, { color: any; width?: number }>>(new Map());

  // Filter state
  const [filterMode, setFilterMode] = useState<FilterMode>(null);
  const [selectedName, setSelectedName] = useState<string>("");
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [legendActive, setLegendActive] = useState<Set<string>>(new Set(groups));

  const activeFilterLabel = useMemo(() => {
    if (filterMode === "id" && selectedName) return `Filter: ${selectedName}`;
    if (filterMode === "group" && selectedGroup) return `Filter: ${selectedGroup} (group)`;
    if (filterMode === "legend") {
      const fams = Array.from(legendActive);
      if (fams.length === 1) return `Filter: ${fams[0]} (legend)`;
      if (fams.length > 1) return `Filter: ${fams.slice(0, 2).join(", ")}${fams.length > 2 ? "…" : ""} (legend)`;
    }
    return null;
  }, [filterMode, selectedName, selectedGroup, legendActive]);

  // Lifecycle editor state
  const [lifecycleMode, setLifecycleMode] = useState<"none" | "create" | "edit">("none");
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  // Dirty tracking
  const [dirty, setDirty] = useState(false);
  const markDirty = () => setDirty(true);
  const markClean = () => setDirty(false);

  // Active edges (custom lifecycle) as keys "src->tgt"
  const [activeEdgeKeys, setActiveEdgeKeys] = useState<Set<string>>(new Set());
  const startNodeId = useMemo(() => nodes.find((r) => r.Name.toLowerCase() === "specify needs")?.NameID ?? "", [nodes]);
  const disposeId = useMemo(() => nodes.find((r) => r.Name.toLowerCase() === "dispose")?.NameID ?? "", [nodes]);
  const shareId = useMemo(() => nodes.find((r) => r.Name.toLowerCase() === "share")?.NameID ?? "", [nodes]);

  const activeNodeIds = useMemo(() => bfsReachable(startNodeId, activeEdgeKeys), [startNodeId, activeEdgeKeys]);

  // Left-pane editor adjacency
  const outgoingBySource = useMemo(() => {
    const m = new Map<string, EdgeRow[]>();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, []);
      m.get(e.source)!.push(e);
    }
    return m;
  }, [edges]);

  // CSV load
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

  // After CSVs load, hydrate from URL hash or localStorage
  useEffect(() => {
    if (nodes.length === 0 || edges.length === 0) return;

    const applyState = (st: AppPersist) => {
      setLifecycleMode(st.lifecycleMode);
      setTitle(st.title || "");
      setDescription(st.description || "");
      setActiveEdgeKeys(new Set(st.activeEdgeKeys || []));
      setFilterMode(st.filterMode ?? null);
      setSelectedName(st.selectedName || "");
      setSelectedGroup(st.selectedGroup || "");
      setLegendActive(new Set(st.legendActive || groups));
      if (st.edgeDescriptions?.length) {
        const merged = edges.slice();
        for (const d of st.edgeDescriptions) {
          const idx = merged.findIndex((x) => x.source === d.source && x.target === d.target);
          if (idx >= 0) merged[idx] = { ...merged[idx], description: d.description ?? merged[idx].description };
        }
        setEdges(merged);
      }
      markClean();
    };

    const hash = window.location.hash;
    if (hash.startsWith("#state=")) {
      try {
        const decoded = base64UrlDecode(hash.slice(7));
        const parsed = JSON.parse(decoded) as AppPersist;
        applyState(parsed);
        return;
      } catch (e) {
        console.warn("Failed to parse state from URL hash:", e);
      }
    }
    try {
      const raw = localStorage.getItem(LS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as AppPersist;
        applyState(parsed);
      } else {
        setLegendActive(new Set(groups));
      }
    } catch (e) {
      console.warn("Failed to parse localStorage state:", e);
      setLegendActive(new Set(groups));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes.length, edges.length]);

  // Build / rebuild Network with fixed hex positions
  useEffect(() => {
    if (!containerRef.current || nodes.length === 0) return;

    const positions = computeFixedHexPositions(nodes);

    const baseNodes = lifecycleMode === "none"
      ? nodes
      : nodes.filter(n => activeNodeIds.has(n.NameID));

    const baseEdges = lifecycleMode === "none"
      ? edges
      : edges.filter(e => activeEdgeKeys.has(`${e.source}->${e.target}`));

    const { visNodes, visEdges } = buildVisDatasets(baseNodes, baseEdges, {
      positions,
      showEdgeTooltips: lifecycleMode !== "none",
      activeNodeIds: lifecycleMode !== "none" ? activeNodeIds : null
    });

    visNodesRef.current = visNodes;
    visEdgesRef.current = visEdges;

    // Snapshot originals (once per build)
    origNodeStylesRef.current.clear();
    for (const n of visNodes.get()) {
      origNodeStylesRef.current.set(String(n.id), {
        color: (n as any).__origColor ?? (n as any).color,
        font: (n as any).__origFont ?? (n as any).font,
        opacity: 1.0,
      });
    }
    origEdgeStylesRef.current.clear();
    for (const e of visEdges.get()) {
      origEdgeStylesRef.current.set(String(e.id), {
        color: (e as any).__origColor ?? (e as any).color,
        width: (e as any).__origWidth ?? (e as any).width,
      });
    }

    // Create network
    const net = new Network(
      containerRef.current,
      { nodes: visNodes, edges: visEdges },
      {
        autoResize: true,
        physics: { enabled: false },
        interaction: {
          hover: true,
          tooltipDelay: 0,
          multiselect: false,
          dragNodes: false,
          dragView: true,
          zoomView: true,
          selectConnectedEdges: false,
        },
        layout: { improvedLayout: false },
        edges: { arrows: { to: { enabled: true, scaleFactor: 0.8 } }, width: 1.5 },
      }
    );

    // --- Plain DOM tooltip helpers ---
    const tipElRef = { current: null as HTMLDivElement | null };
    const moveHandlerRef = { current: null as ((e: MouseEvent) => void) | null };

    const hideTip = () => {
      if (moveHandlerRef.current) {
        window.removeEventListener("mousemove", moveHandlerRef.current);
        moveHandlerRef.current = null;
      }
      if (tipElRef.current) {
        tipElRef.current?.remove();
        tipElRef.current = null;
      }
    };

    const showTipFromEvent = (evt: any, text: string) => {
      hideTip();
      const el = document.createElement("div");
      el.className =
        "pointer-events-none fixed z-[9999] px-2 py-1 text-xs rounded bg-black text-white shadow";
      el.textContent = text;
      tipElRef.current = el;
      document.body.appendChild(el);

      const move = (e: MouseEvent) => {
        el.style.left = e.clientX + 12 + "px";
        el.style.top = e.clientY + 12 + "px";
      };
      move(evt?.srcEvent ?? (evt as any));

      const onMove = (e: MouseEvent) => move(e);
      window.addEventListener("mousemove", onMove);
      moveHandlerRef.current = onMove;
    };

    // Node tooltips: "Name: Definition"
    net.on("hoverNode", (params: any) => {
      const item = visNodesRef.current!.get(params.node) as any;
      const name = (item && item.label) || nodeById[String(params.node)]?.Name || "";
      const desc = (item && item.title) ? String(item.title) : "";
      const text = name && desc ? `${name}: ${desc}` : (name || desc || "");
      if (text) showTipFromEvent(params.event, text);
    });
    net.on("blurNode", () => hideTip());

    // Edge tooltips (merged text already in .title)
    net.on("hoverEdge", (params: any) => {
      const item = visEdgesRef.current!.get(params.edge) as any;
      const text = (item && item.title) ? String(item.title) : "";
      if (text) showTipFromEvent(params.event, text);
    });
    net.on("blurEdge", () => hideTip());

    // Hide while interacting
    net.on("dragStart", hideTip);
    net.on("zoom", hideTip);
    net.on("dragEnd", hideTip);

    net.setOptions({
      nodes: { labelHighlightBold: true },       // bold labels on hover/selection
      interaction: { hover: true, tooltipDelay: 0 }
    });

    // Anti-pierce curves
    applyAntiPierce(visEdges, positions);
    net.redraw();

    // Frame it
    setTimeout(() => net.fit({ animation: { duration: 450, easingFunction: "easeInOutQuad" } }), 30);

    networkRef.current = net;
    return () => {
      hideTip();
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
      clearDimStyles(
        visNodesRef.current,
        visEdgesRef.current,
        origNodeStylesRef.current,
        origEdgeStylesRef.current
      );
    }
    markDirty();
  }

  function applySelectByName(name: string) {
    setFilterMode("id");
    setSelectedName(name);
    setSelectedGroup("");
    setLegendActive(new Set(groups));

    if (!visNodesRef.current || !visEdgesRef.current) return;
    const id = nameToId[name.toLowerCase()];
    if (!id) return;

    const visNodes = visNodesRef.current!;
    const visEdges = visEdgesRef.current!;

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
    markDirty();
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
    markDirty();
  }

  function toggleLegendFamily(fam: string) {
    if (!visNodesRef.current || !visEdgesRef.current) return;

    // next active set
    let nextActive: Set<string>;
    if (filterMode !== "legend") {
      nextActive = new Set([fam]);
    } else {
      nextActive = new Set(legendActive);
      if (nextActive.has(fam)) nextActive.delete(fam);
      else nextActive.add(fam);
      if (nextActive.size === 0) nextActive.add(fam);
    }

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
    markDirty();
  }

  // -----------------------------
  // Graph controls (fluid zoom, doubled pan speed)
  // -----------------------------
  function zoomIn(step = 1.01) {
    networkRef.current?.moveTo({ scale: (networkRef.current?.getScale() || 1) * step });
  }
  function zoomOut(step = 1.01) {
    networkRef.current?.moveTo({ scale: (networkRef.current?.getScale() || 1) / step });
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

  // --- Global stop for holds when mouse/touch released, blur, or hidden ---
  useEffect(() => {
    const stopAll = () => stopHold();
    const stopIfHidden = () => { if (document.hidden) stopHold(); };
    window.addEventListener("mouseup", stopAll);
    window.addEventListener("touchend", stopAll);
    window.addEventListener("blur", stopAll);
    document.addEventListener("visibilitychange", stopIfHidden);
    return () => {
      window.removeEventListener("mouseup", stopAll);
      window.removeEventListener("touchend", stopAll);
      window.removeEventListener("blur", stopAll);
      document.removeEventListener("visibilitychange", stopIfHidden);
    };
  }, []);

  // --- Keyboard: same global hold controller for arrows and +/- ---
  useEffect(() => {
    const keyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;
      if (e.key === "ArrowUp") beginHold(() => pan(0, PAN_STEP));
      else if (e.key === "ArrowDown") beginHold(() => pan(0, -PAN_STEP));
      else if (e.key === "ArrowLeft") beginHold(() => pan(PAN_STEP, 0));
      else if (e.key === "ArrowRight") beginHold(() => pan(-PAN_STEP, 0));
      else if (e.key === "=" || e.key === "+") beginHold(() => zoomIn(1.01));
      else if (e.key === "-" || e.key === "_") beginHold(() => zoomOut(1.01));
    };
    const keyUp = () => stopHold();
    window.addEventListener("keydown", keyDown);
    window.addEventListener("keyup", keyUp);
    return () => {
      window.removeEventListener("keydown", keyDown);
      window.removeEventListener("keyup", keyUp);
    };
  }, []);

  // -----------------------------
  // Export current graph as PNG
  // -----------------------------
  function exportPNG() {
    try {
      const canvas: HTMLCanvasElement | undefined =
        (networkRef.current as any)?.canvas?.frame?.canvas;

      if (!canvas) {
        alert("Canvas not available yet. Try again in a moment.");
        return;
      }

      const scale = 2; // 2x export
      const w = canvas.width;
      const h = canvas.height;

      const exportCanvas = document.createElement("canvas");
      exportCanvas.width = w * scale;
      exportCanvas.height = h * scale;

      const ctx = exportCanvas.getContext("2d");
      if (!ctx) {
        alert("Could not create export context.");
        return;
      }
      ctx.scale(scale, scale);
      ctx.drawImage(canvas, 0, 0);

      const dataURL = exportCanvas.toDataURL("image/png");
      const a = document.createElement("a");
      a.href = dataURL;
      a.download = `lifecycle_graph_${new Date().toISOString().slice(0,10)}.png`;
      a.click();
      markClean();
    } catch (err) {
      console.error(err);
      alert("Export failed. Check console for details.");
    }
  }

  // -----------------------------
  // Export SVG (vector snapshot)
  // -----------------------------
  function exportSVG() {
    try {
      const net = networkRef.current;
      const visNodes = visNodesRef.current;
      const visEdges = visEdgesRef.current;
      if (!net || !visNodes || !visEdges) {
        alert("Graph not ready yet.");
        return;
      }

      // Get absolute positions
      const ids = visNodes.getIds() as (string | number)[];
      const pos = net.getPositions(ids as (string | number)[] as string[]);
      const nodeItems = visNodes.get(ids);

      // Bounds
      let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
      for (const id of ids) {
        const p = pos[String(id)];
        if (!p) continue;
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
      const pad = 60;
      const width = (maxX - minX) + pad * 2;
      const height = (maxY - minY) + pad * 2;

      const toSX = (x: number) => (x - minX) + pad;
      const toSY = (y: number) => (y - minY) + pad;

      const edgeItems = visEdges.get();
      const defs = `
        <defs>
          <marker id="arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
            <path d="M 0 0 L 10 5 L 0 10 z"></path>
          </marker>
        </defs>
      `;

      const edgesSvg = edgeItems.map((e: any) => {
        const from = pos[String(e.from)];
        const to = pos[String(e.to)];
        if (!from || !to) return "";
        const color = e.color?.color || "#555";
        return `<line x1="${toSX(from.x)}" y1="${toSY(from.y)}" x2="${toSX(to.x)}" y2="${toSY(to.y)}" stroke="${color}" stroke-width="${e.__origWidth ?? 1.5}" marker-end="url(#arrow)" />`;
      }).join("\n");

      const nodesSvg = (nodeItems as any[]).map((n) => {
        const p = pos[String(n.id)];
        if (!p) return "";
        const radius = Math.max(6, Math.min(16, Number(n.size ?? 12)));
        const fill = n.color?.background || "#e5e7eb";
        const stroke = n.color?.border || "#111827";
        const rawLabel = (n.label ?? "").toString();
        const label = rawLabel.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        return `
          <g>
            <circle cx="${toSX(p.x)}" cy="${toSY(p.y)}" r="${radius}" fill="${fill}" stroke="${stroke}" stroke-width="1.5" />
            <text x="${toSX(p.x)}" y="${toSY(p.y) - radius - 6}" font-family="ui-sans-serif, system-ui" font-size="10" text-anchor="middle" fill="#111">
              ${label}
            </text>
          </g>
        `;
      }).join("\n");

      const svg = `
        <svg xmlns="http://www.w3.org/2000/svg" width="${Math.round(width)}" height="${Math.round(height)}" viewBox="0 0 ${Math.round(width)} ${Math.round(height)}">
          ${defs}
          <g>${edgesSvg}</g>
          <g>${nodesSvg}</g>
        </svg>
      `.trim();

      const blob = new Blob([svg], { type: "image/svg+xml;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lifecycle_graph_${new Date().toISOString().slice(0,10)}.svg`;
      a.click();
      URL.revokeObjectURL(url);
      markClean();
    } catch (err) {
      console.error(err);
      alert("SVG export failed. Check console for details.");
    }
  }

  // -----------------------------
  // Custom Lifecycle: validate + save
  // -----------------------------
  function getLifecycleErrors(): string[] {
    const errs: string[] = [];

    if (!title.trim()) errs.push("A Title is required.");
    if (!description.trim()) errs.push("A Description is required.");

    if (!startNodeId) errs.push("The required start node 'Specify needs' was not found.");
    if (!disposeId) errs.push("The required end node 'Dispose' was not found.");
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
        errs.push(`'${nodeName}' is an endpoint, but only 'Dispose' or 'Share' may end a branch.`);
      }
    }

    // unreachable sources
    for (const key of activeEdgeKeys) {
      const [src] = key.split("->");
      if (!reachable.has(src)) {
        const srcName = nodeById[src]?.Name || src;
        errs.push(`Edge from '${srcName}' is active, but '${srcName}' is not reachable from 'Specify needs'.`);
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

    const nodeIds = Array.from(activeNodeIds);
    const nodesOut = nodeIds.map((id) => nodeById[id]).filter(Boolean) as NodeRow[];

    const edgesOutRaw: EdgeRow[] = [];
    for (const key of activeEdgeKeys) {
      const [src, tgt] = key.split("->");
      const found = edges.find((e) => e.source === src && e.target === tgt);
      if (found) edgesOutRaw.push(found);
    }

    const edgesOut = edgesOutRaw.map((e, i) => ({
      id: i + 1,
      source: e.source,
      target: e.target,
      group: nodeById[e.source]?.FamilyID || "",
      description: e.description || "No description",
    }));

    const now = new Date();
    const meta = [
      ["Title", "Description", "CreatedDate", "CreatedTime"],
      [title, description, now.toISOString().slice(0, 10), now.toTimeString().slice(0, 8)],
    ];

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(meta), "Metadata");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(nodesOut), "Nodes");
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(edgesOut), "Edges");

    const safeTitle = (title || "CustomLifecycle").replace(/[^a-z0-9]+/gi, "_");
    XLSX.writeFile(wb, `${safeTitle}_${now.toISOString().slice(0, 10)}.xlsx`);

    markClean();
  }

  function setEdgeActive(edge: EdgeRow, active: boolean) {
    const key = `${edge.source}->${edge.target}`;
    const next = new Set(activeEdgeKeys);
    if (active) next.add(key);
    else next.delete(key);
    setActiveEdgeKeys(next);
    markDirty();
  }

  function resetLifecycle() {
    setLifecycleMode("none");
    setTitle("");
    setDescription("");
    setActiveEdgeKeys(new Set());
    clearFilters();
    markDirty();
  }

  function startLifecycleCreate() {
    setLifecycleMode("create");
    setTitle("");
    setDescription("");
    setActiveEdgeKeys(new Set());
    markDirty();
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
      markDirty();
    } catch (err: any) {
      alert("Failed to load lifecycle: " + (err?.message || "Unknown error"));
    }
  }

  // Limit filter options to active subset when in lifecycle mode
  const filterableNodes = useMemo(
    () => (lifecycleMode === "none" ? nodes : nodes.filter((n) => activeNodeIds.has(n.NameID))),
    [nodes, lifecycleMode, activeNodeIds]
  );
  const filterableGroups = useMemo(() => Array.from(new Set(filterableNodes.map((n) => n.Family))).sort(), [filterableNodes]);

  const activeLabelTextClass = isDark ? "text-neutral-100" : "text-gray-800";

  // -----------------------------
  // AUTOSAVE (debounced) & UNLOAD GUARD
  // -----------------------------
  const snapshot = useMemo<AppPersist>(() => {
    const edgeDescriptions = edges.map(e => ({ source: e.source, target: e.target, description: e.description }));
    return {
      lifecycleMode,
      title,
      description,
      activeEdgeKeys: Array.from(activeEdgeKeys),
      filterMode,
      selectedName,
      selectedGroup,
      legendActive: Array.from(legendActive),
      edgeDescriptions,
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lifecycleMode, title, description, activeEdgeKeys, filterMode, selectedName, selectedGroup, legendActive, edges]);

  useEffect(() => {
    const t = setTimeout(() => {
      try {
        localStorage.setItem(LS_KEY, JSON.stringify(snapshot));
      } catch (e) {
        console.warn("localStorage save failed", e);
      }
    }, 1000);
    return () => clearTimeout(t);
  }, [snapshot]);

  useEffect(() => {
    const handler = (e: BeforeUnloadEvent) => {
      if (!dirty) return;
      e.preventDefault();
      e.returnValue = "";
    };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [dirty]);

  // -----------------------------
  // Export / Import JSON & Share Link
  // -----------------------------
  function exportJSON() {
    try {
      const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `lifecycle_state_${new Date().toISOString().slice(0,10)}.json`;
      a.click();
      URL.revokeObjectURL(url);
      markClean();
    } catch (e) {
      console.error(e);
      alert("JSON export failed.");
    }
  }

  function importJSON(file: File) {
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(String(reader.result)) as AppPersist;
        const encoded = base64UrlEncode(JSON.stringify(parsed));
        window.location.hash = `#state=${encoded}`;
        setLifecycleMode(parsed.lifecycleMode);
        setTitle(parsed.title || "");
        setDescription(parsed.description || "");
        setActiveEdgeKeys(new Set(parsed.activeEdgeKeys || []));
        setFilterMode(parsed.filterMode ?? null);
        setSelectedName(parsed.selectedName || "");
        setSelectedGroup(parsed.selectedGroup || "");
        setLegendActive(new Set(parsed.legendActive || groups));
        if (parsed.edgeDescriptions?.length) {
          const merged = edges.slice();
          for (const d of parsed.edgeDescriptions) {
            const idx = merged.findIndex((x) => x.source === d.source && x.target === d.target);
            if (idx >= 0) merged[idx] = { ...merged[idx], description: d.description ?? merged[idx].description };
          }
          setEdges(merged);
        }
        markClean();
      } catch (e) {
        console.error(e);
        alert("Invalid JSON file.");
      }
    };
    reader.readAsText(file);
  }

  async function copyShareLink() {
    try {
      const encoded = base64UrlEncode(JSON.stringify(snapshot));
      const url = `${location.origin}${location.pathname}${location.search}#state=${encoded}`;
      await navigator.clipboard.writeText(url);
      alert("Share link copied to clipboard!");
      markClean();
    } catch (e) {
      console.error(e);
      alert("Could not copy link. Your browser may block clipboard access.");
    }
  }

  // -----------------------------
  // Render
  // -----------------------------
  return (
    <div className="min-h-screen grid grid-cols-1 lg:grid-cols-[360px_1fr]">
      {/* Left Pane */}
      <aside className={`border-r ${ui.asideBg} backdrop-blur p-4 flex flex-col gap-4`}>
        {/* Centered title + two sibling buttons */}
        <div className="mb-3 flex flex-col items-center gap-3">
          <h2 className="text-lg font-semibold text-center">
            Data and Information Lifecycle Builder
          </h2>

          {lifecycleMode === "none" ? (
            <>
              <div className="flex items-center justify-center gap-3">
                <button onClick={startLifecycleCreate} className={`px-3 py-1.5 ${ui.btnPill}`}>
                  Start Custom Lifecycle
                </button>
                <button onClick={() => fileInputRef.current?.click()} className={`px-3 py-1.5 ${ui.btnPill}`}>
                  Edit Custom Lifecycle
                </button>
              </div>

              {/* Hidden file input (triggered by Edit button) */}
              <input
                ref={fileInputRef}
                type="file"
                accept=".xlsx"
                className="hidden"
                onChange={(e) => e.target.files && handleLifecycleLoad(e.target.files[0])}
              />
            </>
          ) : (
            <button
              className={`px-3 py-1.5 ${ui.btnPill}`}
              onClick={() => {
                const lose = confirm("Cancel Custom Lifecycle? Unsaved progress will be lost.");
                if (lose) resetLifecycle();
              }}
            >
              Cancel Custom Lifecycle
            </button>
          )}
        </div>

        {/* Scrollable content */}
        <div className="flex-1 overflow-y-auto pr-1">
          {lifecycleMode !== "none" && (
            <div className="space-y-3">
              <p className={isDark ? "text-sm text-neutral-300" : "text-sm text-gray-600"}>
                Lifecycles start at <b>Specify needs</b> and end at <b>Dispose</b>. Branches may rejoin the main path or end at <b>Share</b>. Cycles are allowed.
                A lifecycle must have a <b>Title</b> and <b>Description</b>. Bi-directional edges require two selections.
              </p>

              <div className="grid grid-cols-1 gap-2">
                <input
                  className={ui.input}
                  placeholder="Lifecycle Title"
                  value={title}
                  onChange={(e) => { setTitle(e.target.value); markDirty(); }}
                />
                <textarea
                  className={ui.input}
                  placeholder="Lifecycle Description"
                  value={description}
                  onChange={(e) => { setDescription(e.target.value); markDirty(); }}
                  rows={3}
                />
              </div>

              {/* Grouped, collapsible editor */}
              <div className="mt-2">
                {filterableGroups.map((fam) => (
                  <details key={fam} className={isDark ? "border border-neutral-700 rounded-md mb-2 bg-neutral-900 shadow-sm" : "border rounded-md mb-2 bg-white shadow-sm"} open>
                    <summary className={isDark ? "px-3 py-2 cursor-pointer bg-neutral-800 font-medium text-sm flex items-center justify-between" : "px-3 py-2 cursor-pointer bg-gray-100 font-medium text-sm flex items-center justify-between"}>
                      <span>{fam}</span>
                    </summary>

                    <div className="p-3 space-y-3">
                      {nodes
                        .filter((n) => n.Family === fam)
                        .map((n) => {
                          const isNodeActive = activeNodeIds.has(n.NameID) || n.NameID === startNodeId;

                          return (
                            <details
                              key={n.NameID}
                              className={`border rounded-md shadow-sm ${
                                isNodeActive ? (isDark ? "bg-neutral-900 border-neutral-700" : "bg-white") : (isDark ? "bg-neutral-900/70 border-neutral-700 opacity-60" : "bg-gray-50 opacity-60")
                              }`}
                              open={n.NameID === startNodeId}
                            >
                              <summary className="px-3 py-2 cursor-pointer flex items-center justify-between">
                                <span className="font-medium text-sm">{n.Name}</span>
                                <span
                                  className={`text-[10px] px-2 py-0.5 rounded-full font-semibold ${
                                    isNodeActive ? "bg-emerald-600 text-white" : "bg-gray-400 text-white"
                                  }`}
                                >
                                  {isNodeActive ? "Active" : "Inactive"}
                                </span>
                              </summary>

                              <div className="p-3 space-y-3">
                                {/* Node description editor */}
                                <div>
                                  <label className={isDark ? "block text-xs text-neutral-400 mb-1" : "block text-xs text-gray-600 mb-1"}>
                                    Node description (editable for this lifecycle)
                                  </label>
                                  <textarea
                                    disabled={!isNodeActive}
                                    className={`${ui.input} disabled:bg-opacity-60`}
                                    defaultValue={n.Definition}
                                    onChange={markDirty}
                                  />
                                </div>

                                {/* Outgoing edges */}
                                <div className="space-y-2">
                                  <div className={isDark ? "text-xs font-semibold text-neutral-200" : "text-xs font-semibold text-gray-700"}>
                                    Outgoing edges
                                  </div>

                                  {(outgoingBySource.get(n.NameID) || []).map((e) => {
                                    const key = `${e.source}->${e.target}`;
                                    const isEdgeOn = activeEdgeKeys.has(key);
                                    const targetName = nodeById[e.target]?.Name || e.target;

                                    // only toggle edges from active nodes
                                    const canEditThisEdge = n.NameID === startNodeId || activeNodeIds.has(n.NameID);

                                    return (
                                      <div
                                        key={key}
                                        className={`border rounded-md p-2 flex flex-col gap-2 text-sm shadow-sm ${
                                          canEditThisEdge
                                            ? (isDark ? "bg-neutral-900 border-neutral-700" : "bg-white")
                                            : (isDark ? "bg-neutral-900/70 border-neutral-700" : "bg-gray-100")
                                        }`}
                                      >
                                        <label className="flex items-center gap-2">
                                          <input
                                            type="checkbox"
                                            disabled={!canEditThisEdge}
                                            checked={isEdgeOn}
                                            onChange={(ev) => setEdgeActive(e, ev.target.checked)}
                                          />
                                          <span className="text-sm">
                                            {n.Name} → {targetName}
                                          </span>
                                        </label>

                                        <input
                                          type="text"
                                          className={ui.input}
                                          placeholder="Edge description (optional)"
                                          value={e.description || ""}
                                          onChange={(ev) => {
                                            const val = ev.target.value;
                                            const idx = edges.findIndex((x) => x.source === e.source && x.target === e.target);
                                            if (idx >= 0) {
                                              const next = edges.slice();
                                              next[idx] = { ...next[idx], description: val };
                                              setEdges(next);
                                              markDirty();
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
            </div>
          )}
        </div>

        {/* Fixed footer with divider (only when creating/editing) */}
        {lifecycleMode !== "none" && (
          <div className={`mt-3 pt-3 border-t ${ui.divider} flex items-center gap-2`}>
            <button
              className={`px-3 py-1.5 ${ui.btnPill}`}
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
              className={`px-3 py-1.5 ${ui.btnPill} disabled:opacity-50`}
              disabled={getLifecycleErrors().length > 0}
              onClick={saveLifecycle}
            >
              Save Lifecycle (XLSX)
            </button>
          </div>
        )}
      </aside>

      {/* Right Pane */}
      <section className="relative">
        {/* Export (top-left) */}
        <div className={`absolute top-3 left-3 z-10 rounded-lg p-3 shadow ${ui.panel}`}>
          <div className={ui.panelTitle}>Export</div>
          <div className="flex flex-col gap-2">
            <div className="flex gap-2">
              <button className={`px-2 py-1 ${ui.btnPill}`} onClick={exportPNG}>PNG</button>
              <button className={`px-2 py-1 ${ui.btnPill}`} onClick={exportSVG}>SVG</button>
              <button className={`px-2 py-1 ${ui.btnPill}`} onClick={exportJSON}>JSON</button>
            </div>
            <div className="flex gap-2">
              <button className={`px-2 py-1 ${ui.btnPill}`} onClick={copyShareLink}>Copy Share Link</button>
              <button className={`px-2 py-1 ${ui.btnPill}`} onClick={() => importJsonRef.current?.click()}>Import JSON</button>
              <input
                ref={importJsonRef}
                className="hidden"
                type="file"
                accept="application/json"
                onChange={(e) => e.target.files && importJSON(e.target.files[0])}
              />
            </div>
          </div>
        </div>

        {/* View (bottom-left) */}
        <div className={`absolute bottom-3 left-3 z-10 rounded-lg p-3 shadow ${ui.panel}`}>
          <div className={ui.panelTitle}>View</div>
          <div className="grid grid-cols-3 gap-1">
            <div />
            {/* Up */}
            <HoldButton className={`px-2 py-1 ${ui.btnPill}`} onHold={() => beginHold(() => pan(0, PAN_STEP))}>↑</HoldButton>
            <div />
            {/* Left */}
            <HoldButton className={`px-2 py-1 ${ui.btnPill}`} onHold={() => beginHold(() => pan(PAN_STEP, 0))}>←</HoldButton>
            {/* Down */}
            <HoldButton className={`px-2 py-1 ${ui.btnPill}`} onHold={() => beginHold(() => pan(0, -PAN_STEP))}>↓</HoldButton>
            {/* Right */}
            <HoldButton className={`px-2 py-1 ${ui.btnPill}`} onHold={() => beginHold(() => pan(-PAN_STEP, 0))}>→</HoldButton>
          </div>
        </div>

        {/* Zoom (bottom-right) as horizontal: +  -  Fit */}
        <div className={`absolute bottom-3 right-3 z-10 rounded-lg p-3 shadow ${ui.panel}`}>
          <div className={ui.panelTitle}>Zoom</div>
          <div className="flex items-center gap-2">
            <HoldButton className={`px-2 py-1 ${ui.btnPill}`} onHold={() => beginHold(() => zoomIn(1.01))}>＋</HoldButton>
            <HoldButton className={`px-2 py-1 ${ui.btnPill}`} onHold={() => beginHold(() => zoomOut(1.01))}>－</HoldButton>
            <button className={`px-2 py-1 ${ui.btnPill}`} onClick={fit}>Fit</button>
          </div>
        </div>

        {/* Filters (top-right) */}
        <div className="absolute top-3 right-3 z-10 flex flex-col gap-3 w-[min(210px,calc(100vw-48px))]">
          {activeFilterLabel && (
            <div className={`rounded-lg p-2 shadow ${ui.panel}`}>
              <div className={`text-[10px] font-semibold leading-tight break-words max-h-32 overflow-y-auto ${activeLabelTextClass}`}>
                {activeFilterLabel}
              </div>
            </div>
          )}

          <div className={`rounded-lg p-3 shadow ${ui.panel}`}>
            <div className={ui.panelTitle}>Select by Name</div>
            <select
              className={ui.input}
              value={selectedName}
              onChange={(e) => {
                if (e.target.value) applySelectByName(e.target.value);
                else clearFilters();
              }}
            >
              <option value="">—</option>
              {filterableNodes.map((n) => (
                <option key={n.NameID} value={n.Name}>
                  {n.Name}
                </option>
              ))}
            </select>
          </div>

          <div className={`rounded-lg p-3 shadow ${ui.panel}`}>
            <div className={ui.panelTitle}>Select by Group</div>
            <select
              className={ui.input}
              value={selectedGroup}
              onChange={(e) => {
                const val = e.target.value;
                if (val) applySelectByGroup(val);
                else clearFilters();
              }}
            >
              <option value="">—</option>
              {filterableGroups.map((g) => (
                <option key={g} value={g}>
                  {g}
                </option>
              ))}
            </select>
          </div>

          <div className={`rounded-lg p-3 shadow ${ui.panel}`}>
            <div className={ui.panelTitle}>Legend</div>
            <div className="flex flex-wrap gap-2">
              {filterableGroups.map((fam) => {
                const active = filterMode === "legend" ? legendActive.has(fam) : true;
                return (
                  <button
                    key={fam}
                    onClick={() => toggleLegendFamily(fam)}
                    className={`px-2 py-1 rounded-full text-sm ${active ? ui.chipActive : ui.chipInactive}`}
                  >
                    {fam}
                  </button>
                );
              })}
            </div>
            <div className="mt-3">
              <button className={`px-3 py-1.5 ${ui.btnPill}`} onClick={clearFilters}>
                Clear Filters
              </button>
            </div>
          </div>
        </div>

        {/* Graph canvas */}
        <div ref={containerRef} className="w-full h-[calc(100vh-0px)]" />
      </section>
    </div>
  );
}

/** Small hold-to-repeat button helper using the global controller */
function HoldButton({
  className,
  onHold,
  children,
}: {
  className?: string;
  onHold: () => void;
  children: any;
}) {
  return (
    <button
      className={className}
      onMouseDown={() => onHold()}   // beginHold is called in the handler passed in
      onMouseUp={() => stopHold()}
      onMouseLeave={() => stopHold()}
      onTouchStart={() => onHold()}
      onTouchEnd={() => stopHold()}
    >
      {children}
    </button>
  );
}
