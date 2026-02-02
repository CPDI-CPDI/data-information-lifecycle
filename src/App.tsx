// No default React import needed
import { useEffect, useMemo, useRef, useState } from "react";
import * as Papa from "papaparse";
import * as XLSX from "xlsx";

import GuideOverlay from "./components/GuideOverlay";
import MicroGuideOverlay, { type MicroGuideKey } from "./components/MicroGuideOverlay";

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
 *
 * For examples (Option B): put .xlsx files under src/examples/
 *   - They will be discovered via import.meta.glob and bundled.
 *   - No need to place them in public/ for the dropdown to work.
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
const GAP_X = 180;
const GAP_Y = 140;

// Row counts 5,4,4,4. Offsets provide the staggered hex pattern.
const HEX_ROWS = [
  { count: 5, offsetCols: 0 },
  { count: 4, offsetCols: 0 },
  { count: 4, offsetCols: 0.5 },
  { count: 4, offsetCols: 0 },
];

const ANCHORS: Record<string, { r: number; c: number }> = {
  "specify needs": { r: 0, c: 0 },
  "discover":      { r: 0, c: 1 },
  "use":           { r: 0, c: 2 },
  "access":        { r: 0, c: 3 },
  "protect":       { r: 0, c: 4 },

  "acquire":        { r: 1, c: 0 },
  "clean":          { r: 1, c: 1 },
  "contextualise":  { r: 1, c: 2 }, // British spelling per your note
  "contextualize":  { r: 1, c: 2 }, // keep alias just in case
  "maintain":       { r: 1, c: 3 },

  "store":    { r: 2, c: 0 },
  "analyse":  { r: 2, c: 1 },
  "analyze":  { r: 2, c: 1 }, // alias
  "curate":   { r: 2, c: 2 },
  "share":    { r: 2, c: 3 },

  "preserve": { r: 3, c: 2 },
  "dispose":  { r: 3, c: 3 },
};

const padLabel = (s: string) => `\u2007${s}\u2007`; // thin padding around labels

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

  // Legend chips — common base: uniform width + centered text
  const chipBase =
  "rounded-full text-[12px] leading-none text-center px-3 py-1 min-w-[140px] " +
  "truncate whitespace-nowrap overflow-hidden";

  // High-contrast per theme
  const chipActive = isDark
    ? "!bg-black !text-white !border !border-neutral-700 font-semibold shadow-sm hover:opacity-90"
    : "!bg-white !text-black !border !border-neutral-300 font-semibold shadow-sm hover:bg-neutral-50";

  // Inactive looks clearly “off”
  const chipInactive = isDark
    ? "!bg-black/80 !text-white/60 !border !border-neutral-700 opacity-60 hover:bg-black"
    : "!bg-white !text-black/60 !border !border-neutral-300 opacity-60 hover:bg-neutral-50";

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
    chipBase,
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

  // 1) Place anchors exactly
  for (const [lowerName, slot] of nameToSlot) {
    const n = byNameLower[lowerName];
    if (!n) continue;
    const key = `${slot.r}:${slot.c}`;
    const p = posBySlotKey.get(key);
    if (!p) continue;
    positions[n.NameID] = { x: p.x, y: p.y };
    usedSlots.add(key);
  }

  // 2) Prepare remaining nodes with family priority
  //    CONFIGURATION first (bottom-left), then INITIATION/ACQUISITION/PROCESSING/DISPOSITION, and LEVERAGING last (bubbles up).
  const famRank = (famRaw: string) => {
    const fam = canonFam(famRaw);
    if (fam === "CONFIGURATION") return -2;     // strongest priority to occupy bottom-left
    if (fam === "LEVERAGING")    return +2;     // last → bubbles up
    return 0;                                   // middle
  };

  const remaining = nodes
    .filter((n) => positions[n.NameID] === undefined)
    .sort((a, b) => {
      const ra = famRank(a.Family), rb = famRank(b.Family);
      if (ra !== rb) return ra - rb;
      // tiebreakers for stable, deterministic fill
      return (a.Name || "").localeCompare(b.Name || "");
    });

  // 3) Fill remaining slots scanning bottom-left → top-right
  const freeSlots = slots
    .filter(s => !usedSlots.has(`${s.r}:${s.c}`))
    .sort((A, B) => {
      // larger y (row nearer bottom) first; then smaller x (left) first
      if (A.y !== B.y) return B.y - A.y;
      return A.x - B.x;
    });

  for (const s of freeSlots) {
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

  const HIT_R = 18;
  const PADDING = 6;
  const THRESH = HIT_R + PADDING;

  function distPointToSeg(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
    const abx = bx - ax, aby = by - ay;
    const apx = px - ax, apy = py - ay;
    const ab2 = abx * abx + aby * aby || 1;
    let t = (apx * abx + apy * aby) / ab2;
    t = Math.max(0, Math.min(1, t));
    const qx = ax + t * abx, qy = ay + t * aby;
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
      if (d < THRESH) { pierces = true; break; }
    }

    if (pierces) {
      const vx = B.x - A.x, vy = B.y - A.y;
      const mx = (A.x + B.x) / 2, my = (A.y + B.y) / 2;
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

// --- Fixed family tiers (your requested scheme) ---
type Tier = "dark" | "mid" | "soft";
const FAMILY_TIER: Record<string, Tier> = {
  INITIATION: "dark",
  ACQUISITION: "mid",      // keep
  CONFIGURATION: "mid",    // ⬅️ was "dark" — mid makes it less harsh
  PROCESSING: "soft",
  LEVERAGING: "soft",
  DISPOSITION: "mid",

  // long display names map to same family
  "Plan, design & enable": "dark",
  "Create, Capture & Collect": "mid",
  "Access, use & share": "soft",
  "Organize, store & maintain": "dark",
  "Provision, integrate & Curate": "soft",
  "Archive transfer & destroy": "mid",
};

// --- Stable, CVD-friendly base hues per family (distinct around wheel) ---
const BASE_HUES: Record<string, number> = {
  INITIATION: 30,    // keep amber
  ACQUISITION: 190,  // ⬅️ tone down (less “strong blue” than 210)
  LEVERAGING: 305,   // keep
  CONFIGURATION: 0,  // ⬅️ make this true red family hue
  PROCESSING: 95,    // keep
  DISPOSITION: 265,  // keep

  "Plan, design & enable": 30,
  "Create, Capture & Collect": 210,
  "Access, use & share": 285,
  "Organize, store & maintain": 15,
  "Provision, integrate & Curate": 95,
  "Archive transfer & destroy": 265,
};

// === Family canonicalization ===
const FAMILY_CANON: Record<string, string> = {
  // one-word already canonical
  INITIATION: "INITIATION",
  ACQUISITION: "ACQUISITION",
  LEVERAGING: "LEVERAGING",
  CONFIGURATION: "CONFIGURATION",
  PROCESSING: "PROCESSING",
  DISPOSITION: "DISPOSITION",

  // 3-word forms → one-word
  "Plan, design & enable": "INITIATION",
  "Create, Capture & Collect": "ACQUISITION",
  "Access, use & share": "LEVERAGING",
  "Organize, store & maintain": "CONFIGURATION",
  "Provision, integrate & Curate": "PROCESSING",
  "Archive transfer & destroy": "DISPOSITION",
};

function canonFam(f: string): string {
  if (!f) return f;
  return FAMILY_CANON[f] ?? FAMILY_CANON[f.trim()] ?? f;
}

function hsl(h: number, s: number, l: number) {
  return `hsl(${h}, ${s}%, ${l}%)`; // commas = safest for canvas
}

// Given a tier, pick accessible lightness & slightly darker border
function shadeFor(hue:number, tier:Tier) {
  // moderate saturation keeps separability under CVD
  const sat = 62;
  const L = tier === "dark" ? 38 : tier === "mid" ? 58 : 85;   // background
  const bg = hsl(hue, sat, L);
  const border = hsl(hue, Math.min(82, sat + 10), Math.max(22, L - 20));
  const hiBg = hsl(hue, Math.min(80, sat + 6), Math.min(92, L + 8));
  const hiBorder = hsl(hue, Math.min(88, sat + 16), Math.max(18, L - 26));
  return { bg, border, hiBg, hiBorder };
}

// 🔁 DROP-IN REPLACEMENT for makeColorForFamily
function makeColorForFamily(
  family: string
): { border: string; background: string; highlight: { border: string; background: string } } {
  const canonical = canonFam(family);
  const hue = BASE_HUES[canonical] ?? 200;                   // fallback hue
  const tier: Tier = FAMILY_TIER[canonical] ?? "mid";        // fallback tier
  const { bg, border, hiBg, hiBorder } = shadeFor(hue, tier);
  return { border, background: bg, highlight: { border: hiBorder, background: hiBg } };
}

const CANON_FAMILY_ORDER = [
  "INITIATION",
  "ACQUISITION",
  "CONFIGURATION",
  "PROCESSING",
  "LEVERAGING",
  "DISPOSITION",
] as const;

function sortFamiliesCanonical(fams: string[]) {
  const rank = new Map<string, number>(CANON_FAMILY_ORDER.map((f, i) => [f, i]));
  const uniq = Array.from(new Set(fams.map(canonFam)));
  return uniq.sort((a, b) => {
    const ra = rank.has(a) ? (rank.get(a) as number) : 999;
    const rb = rank.has(b) ? (rank.get(b) as number) : 999;
    if (ra !== rb) return ra - rb;
    return a.localeCompare(b);
  });
}

// -----------------------------
// Graph + Filtering logic
// -----------------------------
type FilterMode = null | "id" | "group" | "legend";

// Stronger dim for “not kept”
const DIM_NODE_OPACITY = 0.12;
const DIM_FONT_COLOR = "#6b7280"; // gray-500
const DIM_EDGE_COLOR = "#e5e7eb"; // gray-200
const DIM_EDGE_WIDTH = 0.5;

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
      opacity: keep ? 1.0 : DIM_NODE_OPACITY,
      font: keep
        ? (n as any).__origFont
        : { ...(n as any).__origFont, color: DIM_FONT_COLOR, background: "#000000" },
      color: (n as any).__origColor,
    });
  }

  const edgeUpdates: any[] = [];
  for (const e of visEdges.get()) {
    const keep = keepEdgeIds.has(String(e.id));
    edgeUpdates.push({
      id: e.id as any,
      color: keep ? (e as any).__origColor : { color: DIM_EDGE_COLOR },
      width: keep ? (e as any).__origWidth : DIM_EDGE_WIDTH,
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
    const anyN = n as any;

    nodeUpdates.push({
      id,
      opacity: orig?.opacity ?? 1.0,
      color: orig?.color ?? anyN.__origColor ?? anyN.color,
      font: orig?.font ?? anyN.__origFont ?? anyN.font,
      label: anyN.__origLabel ?? anyN.label,
      __dimmed: false,
    });
  }

  const edgeUpdates: any[] = [];
  for (const e of visEdges.get()) {
    const id = String(e.id);
    const orig = origEdgeStyles.get(id);
    const anyE = e as any;

    edgeUpdates.push({
      id,
      color: orig?.color ?? anyE.__origColor ?? anyE.color,
      width: orig?.width ?? anyE.__origWidth ?? anyE.width,
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
    fontPx?: number; // NEW
  } = {}
) {
  const labelSize = Math.max(9, Math.min(22, options.fontPx ?? 12)); // clamp for readability
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
      const famC = canonFam(n.Family);
      if (!famCache[famC]) famCache[famC] = makeColorForFamily(famC);
      const c = famCache[famC];

      const isActive = options.activeNodeIds ? options.activeNodeIds.has(n.NameID) : true;
      const pos = options.positions?.[n.NameID];
      const size = Math.min(24, Math.max(12, Number(n.size ?? 16)));

      const node: any = {
        id: n.NameID,
        label: padLabel(n.Name),
        title: n.Definition || n.Name,
        group: famC,
        shape: "dot",
        size,
        font: {
          size: labelSize,
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

      const baseColor = isActive
        ? {
            border: c.border,
            background: c.background,
            highlight: { ...c.highlight },
            hover: { ...c.highlight }, // <-- add this
          }
        : {
            border: "#cccccc",
            background: "#e5e7eb",
            highlight: { border: "#a1a1aa", background: "#e5e7eb" },
            hover: { border: "#a1a1aa", background: "#e5e7eb" },
          };

      node.__origColor = JSON.parse(JSON.stringify(baseColor));
      node.__origFont = JSON.parse(JSON.stringify(node.font));
      node.__origLabel = node.label;     // ✅ restore labels after filtering
      node.__dimmed = false;             // ✅ track dim state (used by hover logic)


      return node as VisNode;
    })
  );

  const visEdges = new DataSet<VisEdge>(
    edges.map((e) => {
      const src = nodeMapById[e.source];
      const familyColor = src
        ? makeColorForFamily(canonFam(src.Family))
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
        title: options.showEdgeTooltips ? (tipLines.get(pk) || []).sort().join("\n") : undefined,
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
  nodeDescriptions?: Array<{ NameID: string; Definition: string }>;
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

// ✅ Pan step (kept at 2)
const PAN_STEP = 2;

// -----------------------------
// Main Component
// -----------------------------
export default function App() {
  const base = import.meta.env.BASE_URL || "/";

  const isDark = usePrefersDark();
  const ui = makeUiClasses(isDark);

  // UI state for left-pane disclosure + refs to scroll/focus nodes
  const [openFamilies, setOpenFamilies] = useState<Record<string, boolean>>({});
  const leftPaneRef = useRef<HTMLDivElement | null>(null);
  const nodeDetailsRefs = useRef<Record<string, HTMLDetailsElement | null>>({});

  // Per-node description overrides (by NameID)
  const [nodeDesc, setNodeDesc] = useState<Record<string, string>>({});

  //font slider vars
  const [fontPx, setFontPx] = useState<number>(12); // default label/tooltip size (px)

  // Data
  const [nodes, setNodes] = useState<NodeRow[]>([]);
  const [edges, setEdges] = useState<EdgeRow[]>([]);

  // Mappings
  const nodeById = useMemo(() => Object.fromEntries(nodes.map((n) => [n.NameID, n])), [nodes]);
  const nameToId = useMemo(() => Object.fromEntries(nodes.map((n) => [n.Name.toLowerCase(), n.NameID])), [nodes]);
  const orderedFamilies = useMemo(
    () => sortFamiliesCanonical(nodes.map((n) => canonFam(n.Family))),
    [nodes]
  );

  // keep "groups" name if you use it everywhere already
  const groups = orderedFamilies;

  // Graph
  const containerRef = useRef<HTMLDivElement | null>(null);
  const networkRef = useRef<Network | null>(null);
  const visNodesRef = useRef<DataSet<VisNode> | null>(null);
  const visEdgesRef = useRef<DataSet<VisEdge> | null>(null);
  const positionsRef = useRef<Record<string, { x: number; y: number }> | null>(null);

  const [guideOpen, setGuideOpen] = useState(false);

  // viewport persistence
  const initialFitDoneRef = useRef(false); // only auto-fit once
  const viewRef = useRef<{ position: { x: number; y: number }; scale: number } | null>(null);

  type MasterPanelKey = "leftTop" | "leftBottom" | "rightTop" | "rightBottom";

  const [collapsed, setCollapsed] = useState<Record<MasterPanelKey, boolean>>({
    leftTop: false,
    leftBottom: false,
    rightTop: false,
    rightBottom: false,
  });

  const leftTopRef = useRef<HTMLDivElement | null>(null);
  const rightTopRef = useRef<HTMLDivElement | null>(null);
  const leftBottomRef = useRef<HTMLDivElement | null>(null);
  const rightBottomRef = useRef<HTMLDivElement | null>(null);

  const [microGuideKey, setMicroGuideKey] = useState<MicroGuideKey | null>(null);

  // File inputs
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const importJsonRef = useRef<HTMLInputElement | null>(null);

  // Originals (for reliable Clear Filters)
  const origNodeStylesRef = useRef<Map<string, { color: any; font: any; opacity?: number }>>(new Map());
  const origEdgeStylesRef = useRef<Map<string, { color: any; width?: number }>>(new Map());

  // Filter state
  const [filterMode, setFilterMode] = useState<FilterMode>(null);
  const [selectedName, setSelectedName] = useState<string>("");
  const [selectedGroup, setSelectedGroup] = useState<string>("");
  const [legendActive, setLegendActive] = useState<Set<string>>(new Set());

  // whenever families load/refresh, ensure legendActive has defaults if empty
  useEffect(() => {
    setLegendActive((prev) => (prev.size ? prev : new Set(groups)));
  }, [groups]);

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

  const [showGuide, setShowGuide] = useState(true);

  type EdgeMode = "default" | "straight" | "curved";

  const [dragNodes, setDragNodes] = useState<boolean>(false);
  const [tooltipsOn, setTooltipsOn] = useState<boolean>(true);
  const [edgeMode, setEdgeMode] = useState<EdgeMode>("default");

  const tooltipHideRef = useRef<null | (() => void)>(null);
  const tooltipClearTimersRef = useRef<null | (() => void)>(null);

  const uiTitle = (s: string) => (tooltipsOn ? s : undefined);

  // This ref lets your tooltip handlers check the latest value without re-binding events.
  const tooltipsOnRef = useRef(true);
  useEffect(() => {
    tooltipsOnRef.current = tooltipsOn;
    // if tooltips turned off, ensure any currently visible tooltip disappears
    tooltipHideRef.current?.();
    tooltipClearTimersRef.current?.();
  }, [tooltipsOn]);

  const fontPxRef = useRef<number>(fontPx);
  useEffect(() => {
    fontPxRef.current = fontPx;
  }, [fontPx]);

  function closeGuide() {
    setShowGuide(false);
  }

  function applyEdgeMode(
    visEdges: DataSet<VisEdge>,
    positions: Record<string, { x: number; y: number }>,
    mode: EdgeMode
  ) {
    const edges = visEdges.get();
    const updates: Array<Partial<VisEdge> & { id: string | number }> = [];

    if (mode === "default") {
      // Default = anti-pierce (curves only when needed), otherwise straight.
      // Bidirectional naturally overlaps (both straight) unless piercing forces curvature.
      applyAntiPierce(visEdges, positions);
      return;
    }

    if (mode === "straight") {
      for (const e of edges) updates.push({ id: e.id!, smooth: { enabled: false } as any });
      visEdges.update(updates);
      return;
    }

    // mode === "curved"
    // Your existing “bidi ellipse” behavior stays here.
    // Fast lookup for bidirectional
    const pairSet = new Set<string>();
    for (const e of edges) pairSet.add(`${String(e.from)}->${String(e.to)}`);
    const isBidi = (a: string, b: string) => pairSet.has(`${a}->${b}`) && pairSet.has(`${b}->${a}`);

    for (const e of edges) {
      const from = String(e.from), to = String(e.to);
      if (isBidi(from, to)) {
        const type = "curvedCW" as const;
        const roundness = from < to ? 0.30 : 0.22;
        updates.push({ id: e.id!, smooth: { enabled: true, type, roundness } as any });
      } else {
        updates.push({ id: e.id!, smooth: { enabled: true, type: "curvedCW", roundness: 0.22 } as any });
      }
    }
    visEdges.update(updates);
  }


  // Left-pane editor adjacency
  const outgoingBySource = useMemo(() => {
    const m = new Map<string, EdgeRow[]>();
    for (const e of edges) {
      if (!m.has(e.source)) m.set(e.source, []);
      m.get(e.source)!.push(e);
    }
    return m;
  }, [edges]);

  const visibleFamilies = useMemo(() => {
    if (lifecycleMode === "none") return groups;

    const fams = nodes
      .filter((n) => activeNodeIds.has(n.NameID))
      .map((n) => canonFam(n.Family));

    return sortFamiliesCanonical(fams);
  }, [lifecycleMode, groups, nodes, activeNodeIds]);

  // CSV load
  useEffect(() => {
    (async () => {
      try {
        const [n, e] = await Promise.all([
          fetchCsv<NodeRow>(`${base}nodes_final.csv`),
          fetchCsv<EdgeRow>(`${base}edges_final.csv`),
        ]);
        setNodes(n.map(row => ({ ...row, Family: canonFam(row.Family) })));
        setEdges(e);
      } catch (err) {
        console.error(err);
      }
    })();
  }, [base]);

  type ExampleEntry = { name: string; url: string };
  const [exampleFiles, setExampleFiles] = useState<ExampleEntry[]>([]);
  const [selectedExample, setSelectedExample] = useState<string>("");

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${base}examples/manifest.json`, { cache: "no-store" });
        if (!res.ok) throw new Error(`Failed to load examples manifest`);
        const list: string[] = await res.json();

        // natural sort by leading number if present
        const entries = list
          .filter(f => f.toLowerCase().endsWith(".xlsx"))
          .map(f => ({ name: f, url: `${base}examples/${encodeURIComponent(f)}` }))
          .sort((a, b) => {
            const na = parseInt(a.name, 10), nb = parseInt(b.name, 10);
            if (!Number.isNaN(na) && !Number.isNaN(nb) && na !== nb) return na - nb;
            return a.name.localeCompare(b.name);
          });

        setExampleFiles(entries);
        setSelectedExample(entries[0]?.name ?? "");
      } catch (e) {
        console.error(e);
        setExampleFiles([]);
        setSelectedExample("");
      }
    })();
  }, [base]);

  async function loadExampleByName(fname: string) {
    const found = exampleFiles.find(e => e.name === fname);
    if (!found) return;
    const res = await fetch(found.url, { cache: "no-store" });
    if (!res.ok) { alert(`Could not load example: ${fname}`); return; }
    const ab = await res.arrayBuffer();

    // ✅ Reuse EXACTLY the same path as user uploads:
    const file = new File(
      [ab],
      fname,
      { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" }
    );
    await handleLifecycleLoad(file);
  }

  // Hydrate from URL hash or localStorage after data is ready
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
      if (st.nodeDescriptions && st.nodeDescriptions.length) {
        const merged: Record<string, string> = {};
        for (const { NameID, Definition } of st.nodeDescriptions) {
          if (NameID && typeof Definition === "string") merged[NameID] = Definition;
        }
        setNodeDesc(merged);
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

    // Start from canonical fixed positions, but overlay any live dragged positions we saved
    const fixedPositions = computeFixedHexPositions(nodes);
    const positions: Record<string, { x: number; y: number }> = {
      ...fixedPositions,
      ...(positionsRef.current ?? {}),
    };


    const baseNodes = lifecycleMode === "none"
      ? nodes
      : nodes.filter(n => activeNodeIds.has(n.NameID));

    const baseEdges = lifecycleMode === "none"
      ? edges
      : edges.filter(e => activeEdgeKeys.has(`${e.source}->${e.target}`));

    const { visNodes, visEdges } = buildVisDatasets(baseNodes, baseEdges, {
      positions,
      showEdgeTooltips: lifecycleMode !== "none",
      activeNodeIds: lifecycleMode !== "none" ? activeNodeIds : null,
      fontPx,
    });

    visNodesRef.current = visNodes;
    visEdgesRef.current = visEdges;
    positionsRef.current = positions;
    applyEdgeMode(visEdges, positions, edgeMode);

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

    // preserve previous view if we already had a network
    if (networkRef.current) {
      try {
        const prev = networkRef.current;
        const pos = prev.getViewPosition?.();
        const scale = prev.getScale?.();
        if (pos && typeof scale === "number") {
          viewRef.current = { position: pos, scale };
        }
      } catch {}
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
          dragView: !dragNodes, // ✅ if dragNodes is ON, do NOT drag the canvas
          zoomView: true,
          selectConnectedEdges: false,
        },


        nodes: {
          labelHighlightBold: true,
          chosen: false as any,
        },

        edges: {
          arrows: { to: { enabled: true, scaleFactor: 0.8 } },
          width: 1.5,
          chosen: {
            edge: (values: any, id: any, selected: boolean, hovering: boolean) => {
              const e = visEdges.get(id) as any;
              const c = e?.__origColor ?? e?.color;

              const base =
                typeof c === "string"
                  ? c
                  : (c?.color ?? values.color ?? "#999");

              const hi =
                typeof c === "object"
                  ? (typeof c.highlight === "string"
                      ? c.highlight
                      : (c.highlight?.color ?? base))
                  : base;

              const baseW = e?.__origWidth ?? values.width ?? 1.5;

              if (selected || hovering) {
                values.color = hi;
                values.width = baseW + 0.9;
              } else {
                values.color = base;
                values.width = baseW;
              }
            },
          } as any,
        },


        layout: { improvedLayout: false },
      }
    );

    // Ensure current drag setting is applied even after rebuild (e.g., tooltips toggle)
    net.setOptions({
      interaction: {
        dragNodes,
        dragView: !dragNodes,
      },
    });


    // IMPORTANT: re-apply fixed/unfixed after rebuild (fontPx rebuild etc.)
    const ids = visNodes.getIds() as (string | number)[];
    visNodes.update(
      ids.map((id) => ({
        id,
        fixed: dragNodes ? false : { x: true, y: true },
      })) as any
    );

    // --- Plain DOM tooltip helpers (with hover intent) ---
    const tipElRef = { current: null as HTMLDivElement | null };
    const moveHandlerRef = { current: null as ((e: MouseEvent) => void) | null };

    // intent timers
    const showTimerRef = { current: null as any };
    const hideTimerRef = { current: null as any };
    const lastEvtRef = { current: null as null | { evt: any; text: string; kind: "node" | "edge" } };

    // controls (tune these)
    const SHOW_DELAY_MS = 180; // intentional delay before appearing
    const HIDE_DELAY_MS = 20;  // small grace period to reduce flicker

    // placement tuning
    const TIP_GAP = 14;          // distance from cursor
    const TIP_SAFE_PAD = 10;     // keep tooltip inside viewport by this much
    const TIP_MAX_W = 340;       // max tooltip width
    const TIP_MAX_H = 220;       // optional cap (helps huge edge tooltips)

    // optional: if you want tooltip to be less “jumpy” when close to edges
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

    function positionTooltipAtPoint(el: HTMLDivElement, clientX: number, clientY: number, extraGap = 0) {
      // Ensure styles that affect size are set before measuring
      el.style.maxWidth = `${TIP_MAX_W}px`;
      el.style.maxHeight = `${TIP_MAX_H}px`;
      el.style.overflow = "hidden";
      el.style.textOverflow = "ellipsis";

      // We need dimensions; if not in DOM yet, caller must append first
      const rect = el.getBoundingClientRect();

      const vw = window.innerWidth;
      const vh = window.innerHeight;

      // Default: bottom-right of cursor
        let x = clientX + TIP_GAP + extraGap;
        let y = clientY + TIP_GAP + extraGap;

      // Flip horizontally if would overflow right
      if (x + rect.width + TIP_SAFE_PAD > vw) {
        x = clientX - (TIP_GAP + extraGap) - rect.width;
      }

      // Flip vertically if would overflow bottom
      if (y + rect.height + TIP_SAFE_PAD > vh) {
        y = clientY - (TIP_GAP + extraGap) - rect.height;
      }

      // Clamp to viewport
      x = clamp(x, TIP_SAFE_PAD, vw - rect.width - TIP_SAFE_PAD);
      y = clamp(y, TIP_SAFE_PAD, vh - rect.height - TIP_SAFE_PAD);

      el.style.left = `${Math.round(x)}px`;
      el.style.top = `${Math.round(y)}px`;
    }

    const clearTimers = () => {
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }
    };

    const hideTipNow = () => {
      if (moveHandlerRef.current) {
        window.removeEventListener("mousemove", moveHandlerRef.current);
        moveHandlerRef.current = null;
      }
      if (tipElRef.current) {
        tipElRef.current.remove();
        tipElRef.current = null;
      }
    };

    tooltipHideRef.current = hideTipNow;
    tooltipClearTimersRef.current = clearTimers;

    const containerEl = containerRef.current;

    const onLeaveContainer = () => hideTipNow();

    // Use both for safety across browsers/input types
    containerEl?.addEventListener("mouseleave", onLeaveContainer);
    containerEl?.addEventListener("pointerleave", onLeaveContainer);

    const scheduleHide = () => {
      // cancel any pending show
      if (showTimerRef.current) {
        clearTimeout(showTimerRef.current);
        showTimerRef.current = null;
      }
      // schedule hide (grace)
      if (hideTimerRef.current) clearTimeout(hideTimerRef.current);
      hideTimerRef.current = setTimeout(() => {
        hideTimerRef.current = null;
        hideTipNow();
      }, HIDE_DELAY_MS);
    };

    const showTipNow = (evt: any, text: string) => {
      // if already showing, just update content + position
      if (!tipElRef.current) {
        const el = document.createElement("div");
        el.className =
          "pointer-events-none fixed z-[9999] px-2 py-1 rounded bg-black text-white shadow";
        el.style.whiteSpace = "pre-line";
        el.style.maxWidth = `${TIP_MAX_W}px`;
        el.style.fontSize = `${Math.max(9, Math.min(22, fontPxRef.current))}px`;

        el.style.lineHeight = "1.2";
        el.style.borderRadius = "8px";

        tipElRef.current = el;
        document.body.appendChild(el);

        // mouse follower (only while visible)
        let raf = 0;
        const onMove = (e: MouseEvent) => {
          cancelAnimationFrame(raf);
          raf = requestAnimationFrame(() => {
            if (!tipElRef.current) return;
            const kind = lastEvtRef.current?.kind ?? "node";
            const extraGap = kind === "node" ? 10 : 0;
            positionTooltipAtPoint(tipElRef.current, e.clientX, e.clientY, extraGap);
          });
        };

        window.addEventListener("mousemove", onMove);
        moveHandlerRef.current = onMove;
      }

      // update text first so size is accurate
      tipElRef.current.textContent = text;

      // place immediately from triggering event
      const src = evt?.srcEvent ?? evt;
      if (src?.clientX != null && src?.clientY != null && tipElRef.current) {
        // after textContent update, compute correct rect and place
        const kind = lastEvtRef.current?.kind ?? "node";
        const extraGap = kind === "node" ? 10 : 0;
        positionTooltipAtPoint(tipElRef.current, src.clientX, src.clientY, extraGap);
      }
    };

    const scheduleShow = (evt: any, text: string, kind: "node" | "edge") => {
      if (!text) return;

      if (hideTimerRef.current) {
        clearTimeout(hideTimerRef.current);
        hideTimerRef.current = null;
      }

      lastEvtRef.current = { evt, text, kind };

      if (showTimerRef.current) clearTimeout(showTimerRef.current);
      showTimerRef.current = setTimeout(() => {
        showTimerRef.current = null;
        const last = lastEvtRef.current;
        if (!last) return;
        showTipNow(last.evt, last.text);
      }, SHOW_DELAY_MS);
    };

    // Node tooltips
    net.on("hoverNode", (params: any) => {
      if (!tooltipsOnRef.current) {
        scheduleHide();
        return;
      }
      const item = visNodesRef.current!.get(params.node) as any;
      const name = (item && item.label) || nodeById[String(params.node)]?.Name || "";
      const desc = (item && item.title) ? String(item.title) : "";
      const text = name && desc ? `${name}: ${desc}` : (name || desc || "");
      scheduleShow(params.event, text, "node");
    });
    net.on("blurNode", () => {
      if (!tooltipsOnRef.current) return;
      scheduleHide();
    });

    // Edge tooltips
    net.on("hoverEdge", (params: any) => {
      if (!tooltipsOnRef.current) {scheduleHide(); return;}
      const item = visEdgesRef.current!.get(params.edge) as any;
      const text = (item && item.title) ? String(item.title) : "";
      scheduleShow(params.event, text, "edge");
    });
    net.on("blurEdge", () => {
      if (!tooltipsOnRef.current){scheduleHide(); return;}
    });

    // Hide while interacting
    net.on("dragStart", () => {
      clearTimers();
      hideTipNow();
    });
    net.on("zoom", () => {
      clearTimers();
      hideTipNow();
    });
    net.on("dragEnd", () => {
      // optional: keep hidden after drag; if you want tooltips back instantly, do nothing here
    });

    if (!initialFitDoneRef.current) {
      initialFitDoneRef.current = true;
      net.fit({ animation: { duration: 450, easingFunction: "easeInOutQuad" } });
    } else if (viewRef.current) {
      const { position, scale } = viewRef.current;
      net.moveTo({ position, scale, animation: { duration: 0, easingFunction: "easeInOutQuad" } });
    }

    networkRef.current = net;

    // IMPORTANT: vis-network can mutate node color objects on init.
    // Restore palette exactly like Clear Filters does.
    requestAnimationFrame(() => {
      restorePaletteFromOrig();
    });

    return () => {
      try {
        if (networkRef.current) {
          const pos = networkRef.current.getViewPosition?.();
          const scale = networkRef.current.getScale?.();
          if (pos && typeof scale === "number") {
            viewRef.current = { position: pos, scale };
          }
        }
      } catch {}

      clearTimers();
      hideTipNow();
      tooltipHideRef.current = null;
      tooltipClearTimersRef.current = null;

      // ✅ Persist current (possibly dragged) node positions so rebuilds don't snap back
      try {
        const ids = visNodes.getIds() as (string | number)[];
        const posMap = net.getPositions(ids as any);

        const next: Record<string, { x: number; y: number }> = { ...(positionsRef.current ?? {}) };
        for (const id of ids) {
          const p = posMap[String(id)];
          if (p) next[String(id)] = { x: p.x, y: p.y };
        }
        positionsRef.current = next;
      } catch {}

      net.destroy();
      containerEl?.removeEventListener("mouseleave", onLeaveContainer);
      containerEl?.removeEventListener("pointerleave", onLeaveContainer);
      networkRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [nodes, edges, lifecycleMode, activeNodeIds]);

  useEffect(() => {
    const net = networkRef.current;
    const visNodes = visNodesRef.current;
    if (!net || !visNodes) return;

    try {
      net.setOptions({
        interaction: {
          dragNodes,
          dragView: !dragNodes,
          hover: true,
          tooltipDelay: 0,
        },
      });

      const ids = visNodes.getIds() as (string | number)[];
      visNodes.update(
        ids.map((id) => ({
          id,
          fixed: dragNodes ? false : { x: true, y: true },
        })) as any
      );

      // IMPORTANT: restoring palette during an active filter can undo dimming
      if (filterMode === null) {
        restorePaletteFromOrig();
      } else {
        net.redraw();
      }
    } catch (e) {
      console.error("dragNodes toggle failed:", e);
    }
  }, [dragNodes, filterMode]);



  // Ensure a family is open and scroll the left pane so a node is visible
  function openFamilyAndScrollToNode(nodeId: string) {
    const node = nodeById[nodeId];
    if (!node) return;
    const fam = node.Family;

    setOpenFamilies(prev => ({ ...prev, [fam]: true }));

    requestAnimationFrame(() => {
      const el = nodeDetailsRefs.current[nodeId];
      const scroller = leftPaneRef.current;
      if (!el || !scroller) return;
      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add("outline-2", "outline-emerald-500", "outline");
      setTimeout(() => el.classList.remove("outline-2", "outline-emerald-500", "outline"), 900);
    });
  }

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

  function ensureDragNodesOffForFilter() {
    if (!dragNodes) return;

    // Immediately update the vis network (not waiting for React state)
    const net = networkRef.current;
    const visNodes = visNodesRef.current;

    try {
      net?.setOptions({
        interaction: {
          dragNodes: false,
          dragView: true,
        },
      });

      if (visNodes) {
        const ids = visNodes.getIds() as (string | number)[];
        visNodes.update(
          ids.map((id) => ({
            id,
            fixed: { x: true, y: true },
          })) as any
        );
      }
    } catch (e) {
      console.error("ensureDragNodesOffForFilter failed:", e);
    }

    // Update UI state last
    setDragNodes(false);
  }

  function restorePaletteFromOrig() {
    const visNodes = visNodesRef.current;
    const visEdges = visEdgesRef.current;
    if (!visNodes || !visEdges) return;

    // Re-apply exact originals (this is the "Clear Filters magic")
    const nodeUpdates = visNodes.get().map((n: any) => ({
      id: n.id,
      color: n.__origColor ?? n.color,
      font: n.__origFont ?? n.font,
      opacity: typeof n.opacity === "number" ? n.opacity : 1.0,
    }));

    const edgeUpdates = visEdges.get().map((e: any) => ({
      id: e.id,
      color: e.__origColor ?? e.color,
      width: e.__origWidth ?? e.width,
    }));

    visNodes.update(nodeUpdates as any);
    visEdges.update(edgeUpdates as any);
    networkRef.current?.redraw();
}

  // Keep: selected node, its outgoing edges, and those edges’ destination nodes (no incoming)
  function applySelectByName(name: string) {
    // If dragNodes is on, turn it off immediately so filtering applies in the same click
    ensureDragNodesOffForFilter();

    setFilterMode("id");
    setSelectedName(name);
    setSelectedGroup("");
    setLegendActive(new Set(groups));

    if (!visNodesRef.current || !visEdgesRef.current) return;
    const id = nameToId[name.toLowerCase()];
    if (!id) return;

    openFamilyAndScrollToNode(id);

    const visNodes = visNodesRef.current!;
    const visEdges = visEdgesRef.current!;

    const keepNodes = new Set<string>([id]);
    const keepEdges = new Set<string>();

    for (const e of visEdges.get()) {
      const from = String(e.from);
      const to = String(e.to);
      if (from === id) {
        keepEdges.add(String(e.id));
        keepNodes.add(to);
      }
    }

    applyDimStyles(visNodes, visEdges, keepNodes, keepEdges);
    networkRef.current?.redraw();
    markDirty();
  }


  // Keep: nodes in group, their outgoing edges, and the destination nodes
  function applySelectByGroup(group: string) {
    // If dragNodes is on, turn it off immediately so filtering applies in the same click
    ensureDragNodesOffForFilter();

    setFilterMode("group");
    setSelectedGroup(group);
    setSelectedName("");
    setLegendActive(new Set([group]));

    if (!visNodesRef.current || !visEdgesRef.current) return;
    const visNodes = visNodesRef.current;
    const visEdges = visEdgesRef.current;

    const familyNodes = nodes
      .filter((n) => canonFam(n.Family) === group)
      .sort((a, b) => a.Name.localeCompare(b.Name));

    const groupNodeIds = new Set(familyNodes.map((n) => n.NameID));
    const keepNodes = new Set<string>(groupNodeIds);
    const keepEdges = new Set<string>();

    for (const e of visEdges.get()) {
      const from = String(e.from);
      if (groupNodeIds.has(from)) {
        keepEdges.add(String(e.id));
      }
    }

    applyDimStyles(visNodes, visEdges, keepNodes, keepEdges);

    const firstId = familyNodes[0]?.NameID;
    if (firstId) openFamilyAndScrollToNode(firstId);

    networkRef.current?.redraw();
    markDirty();
  }


  // -----------------------------
  // Graph controls
  // -----------------------------
  function zoomIn(step = 1.01) {
    networkRef.current?.moveTo({ scale: (networkRef.current?.getScale() || 1) * step });
  }
  function zoomOut(step = 1.01) {
    networkRef.current?.moveTo({ scale: (networkRef.current?.getScale() || 1) / step });
  }

  function fitUsable() {
    const net = networkRef.current;
    const container = containerRef.current;
    if (!net || !container) return;

    const containerRect = container.getBoundingClientRect();

    const lt = leftTopRef.current?.getBoundingClientRect();      // Save/Export/Groups
    const rt = rightTopRef.current?.getBoundingClientRect();     // Filters
    const lb = leftBottomRef.current?.getBoundingClientRect();   // View
    const rb = rightBottomRef.current?.getBoundingClientRect();  // Label/Zoom/Help

    const pad = 12;

    const leftTopCollapsed = !!collapsed.leftTop;
    const rightBothCollapsed = !!collapsed.rightTop && !!collapsed.rightBottom; // only case we treat as collapsed

    // Helpers: abs -> container local px
    const toLocalX = (absX: number) => absX - containerRect.left;
    const toLocalY = (absY: number) => absY - containerRect.top;

    // Your naming:
    // max y = top boundary (smaller number on screen)
    // min y = bottom boundary (larger number on screen)

    let topAbs = containerRect.top;
    let bottomAbs = containerRect.bottom;
    let leftAbs = (lt?.right ?? containerRect.left);
    let rightAbs = (rt?.left ?? containerRect.right);

    // CASE 1: neither collapsed (default)
    // top = top of page, bottom = bottom of page
    // left = right of left column, right = left of right column
    if (!leftTopCollapsed && !rightBothCollapsed) {
      topAbs = containerRect.top;
      bottomAbs = containerRect.bottom;
      leftAbs = (lt?.right ?? containerRect.left);
      rightAbs = (rt?.left ?? containerRect.right);
    }

    // CASE 2: left top collapsed only
    // top = bottom of groupexport (leftTop)
    // bottom = top of view (leftBottom)
    // left = left of canvas, right = left of right column
    else if (leftTopCollapsed && !rightBothCollapsed) {
      topAbs = (lt?.bottom ?? containerRect.top);
      bottomAbs = (lb?.top ?? containerRect.bottom);
      leftAbs = containerRect.left;
      rightAbs = (rt?.left ?? containerRect.right);
    }

    // CASE 3: BOTH RIGHT PANELS COLLAPSED only
    // top = bottom of filter (rightTop)
    // bottom = top of labelzoom (rightBottom)
    // left = right of left column, right = right of canvas
    else if (!leftTopCollapsed && rightBothCollapsed) {
      topAbs = (rt?.bottom ?? containerRect.top);
      bottomAbs = (rb?.top ?? containerRect.bottom);
      leftAbs = (lt?.right ?? containerRect.left);
      rightAbs = containerRect.right;
    }

    // CASE 4: left top collapsed AND both right collapsed
    // top = bottom of filter
    // bottom = top of view
    // left = left of canvas, right = right of canvas
    else {
      topAbs = (rt?.bottom ?? containerRect.top);
      bottomAbs = (rb?.top ?? containerRect.bottom);
      leftAbs = containerRect.left;
      rightAbs = containerRect.right;
    }

    // Convert usable rect to container-local px
    const topPx = toLocalY(topAbs) + pad;
    const bottomPx = toLocalY(bottomAbs) - pad;
    const leftPx = toLocalX(leftAbs) + pad;
    const rightPx = toLocalX(rightAbs) - pad;

    const limW = Math.max(50, rightPx - leftPx);
    const limH = Math.max(50, bottomPx - topPx);

    const limCenterX = leftPx + limW / 2;
    const limCenterY = topPx + limH / 2;

    // Bounds from visible nodes (better Y-centering than anchors)
    const visNodes = visNodesRef.current;
    if (!visNodes) return;

    const ids = visNodes.getIds() as (string | number)[];
    const posMap = net.getPositions(ids as any);

    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const id of ids) {
      const p = posMap[String(id)];
      if (!p) continue;
      minX = Math.min(minX, p.x);
      minY = Math.min(minY, p.y);
      maxX = Math.max(maxX, p.x);
      maxY = Math.max(maxY, p.y);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY)) return;


    // a bit of padding in graph coords so labels feel safe
    const G_PAD = 30;
    minX -= G_PAD; maxX += G_PAD;
    minY -= G_PAD; maxY += G_PAD;

    const graphW = Math.max(1, maxX - minX);
    const graphH = Math.max(1, maxY - minY);

    const fill = 0.9;
    const scale = Math.min((limW * fill) / graphW, (limH * fill) / graphH);

    const graphCenter = { x: (minX + maxX) / 2, y: (minY + maxY) / 2 };

    // Align graphCenter to usable center
    const containerCenterX = containerRect.width / 2;
    const containerCenterY = containerRect.height / 2;

    const dxPx = limCenterX - containerCenterX;
    const dyPx = limCenterY - containerCenterY;

    const pos = {
      x: graphCenter.x - dxPx / scale,
      y: graphCenter.y - dyPx / scale,
    };

    net.moveTo({
      position: pos,
      scale,
      animation: { duration: 250, easingFunction: "easeInOutQuad" },
    });
  }

  function pan(dx: number, dy: number) {
    const p = networkRef.current?.getViewPosition();
    const s = networkRef.current?.getScale() || 1;
    if (!p) return;
    networkRef.current?.moveTo({ position: { x: p.x - dx / s, y: p.y - dy / s } });
  }
  function resetViewOnly() {
    stopHold();
    const net = networkRef.current;
    const visNodes = visNodesRef.current;
    const positions = positionsRef.current;
    if (!net || !visNodes || !positions) return;

    net.unselectAll();

    const ids = visNodes.getIds() as (string | number)[];
    visNodes.update(
      ids
        .map((id) => {
          const p = positions[String(id)];
          if (!p) return null;
          return {
            id,
            x: p.x,
            y: p.y,
            fixed: dragNodes ? false : { x: true, y: true },
          };
        })
        .filter(Boolean) as any
    );

    restorePaletteFromOrig();

    net.redraw();
    fitUsable();
  }


  // --- Global stop for holds ---
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

  useEffect(() => {
    const visNodes = visNodesRef.current;
    if (!visNodes) return;

    const size = Math.max(9, Math.min(22, fontPx));

    const updates = visNodes.get().map((n: any) => {
      const baseFont = n.__origFont ?? n.font ?? {};
      const nextFont = { ...baseFont, size };
      return {
        id: n.id,
        font: nextFont,
        __origFont: JSON.parse(JSON.stringify(nextFont)), // ✅ clone
      };
    });

    visNodes.update(updates as any);

    restorePaletteFromOrig(); // ✅ keep exactly here

    networkRef.current?.redraw();
  }, [fontPx]);

  // --- Keyboard holds for arrows and +/- ---
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

  useEffect(() => {
    const visEdges = visEdgesRef.current;
    const pos = positionsRef.current;
    if (!visEdges || !pos) return;
    applyEdgeMode(visEdges, pos, edgeMode);
  }, [edgeMode]);

  // -----------------------------
  // Export & Share
  // -----------------------------
  function exportPNG() {
    try {
      const canvas: HTMLCanvasElement | undefined =
        (networkRef.current as any)?.canvas?.frame?.canvas;

      if (!canvas) {
        alert("Canvas not available yet. Try again in a moment.");
        return;
      }

      const scale = 2;
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

  function exportSVG() {
    try {
      const net = networkRef.current;
      const visNodes = visNodesRef.current;
      const visEdges = visEdgesRef.current;
      if (!net || !visNodes || !visEdges) {
        alert("Graph not ready yet.");
        return;
      }

      const ids = visNodes.getIds() as (string | number)[];
      const pos = net.getPositions(ids as (string | number)[] as string[]);
      const nodeItems = visNodes.get(ids);

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

  function exportJSON() {
    try {
      const data = snapshot; // includes nodeDescriptions
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
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
  // LIFECYCLE HELPERS
  // -----------------------------
  function startLifecycleCreate() {
    setLifecycleMode("create");
    setTitle("");
    setDescription("");
    setActiveEdgeKeys(new Set());
    markDirty();
  }

  async function handleLifecycleLoad(file: File) {
    // --- helpers to guarantee TEXT everywhere and kill ".0" tails ---
    const toText = (v: any) => (v == null ? "" : String(v)).trim();
    const stripDot0 = (s: string) => s.replace(/\.0$/, "");

    try {
      const ab = await file.arrayBuffer();
      const wb = XLSX.read(ab);

      const wsMeta  = wb.Sheets["Metadata"];
      const wsNodes = wb.Sheets["Nodes"];
      const wsEdges = wb.Sheets["Edges"];
      if (!wsMeta || !wsNodes || !wsEdges) {
        throw new Error("Expected sheets: Metadata, Nodes, Edges");
      }

      // --- Metadata (Row 2) ---
      const metaAoa = XLSX.utils.sheet_to_json<any>(wsMeta, { header: 1, defval: "" }) as any[][];
      let t = "", d = "";
      if (Array.isArray(metaAoa) && metaAoa[1]) {
        t = toText(metaAoa[1][0]); // Title
        d = toText(metaAoa[1][1]); // Description
      }

      // --- Nodes (force TEXT and strip any '.0') ---
      const rawNodes = XLSX.utils.sheet_to_json<any>(wsNodes, { defval: "" });
      const inNodes: NodeRow[] = (rawNodes as any[]).map((r) => ({
        Name:       toText(r.Name),
        Family:     canonFam(toText(r.Family)),
        NameID:     stripDot0(toText(r.NameID)),
        FamilyID:   stripDot0(toText(r.FamilyID)),
        Definition: toText(r.Definition),
      }));

      // --- Edges (force TEXT and defaults) ---
      const rawEdges = XLSX.utils.sheet_to_json<any>(wsEdges, { defval: "" });
      const inEdges: EdgeRow[] = (rawEdges as any[]).map((r, i) => ({
        id:          toText(r.id) || String(i + 1),
        source:      stripDot0(toText(r.source)),
        target:      stripDot0(toText(r.target)),
        group:       stripDot0(toText(r.group)),           // source FamilyID; recomputed on save anyway
        description: toText(r.description) || "No description",
      }));

      // --- Auto-heal anchor rule for older files -------------------
      // Ensure we contain "Specify needs" and the edge "Specify needs → Acquire".
      const specifyId = nodes.find(n => n.Name.toLowerCase() === "specify needs")?.NameID;
      const acquireId = nodes.find(n => n.Name.toLowerCase() === "acquire")?.NameID;

      if (specifyId && acquireId) {
        const hasSpecify = inNodes.some(n => n.NameID === specifyId);
        if (!hasSpecify) {
          const base = nodes.find(n => n.NameID === specifyId)!;
          // Keep master definition and master family IDs exactly
          inNodes.push({
            Name: base.Name,
            Family: base.Family,
            NameID: base.NameID,
            FamilyID: base.FamilyID,
            Definition: base.Definition,
          });
        }
        const hasSNtoAcquire = inEdges.some(e => e.source === specifyId && e.target === acquireId);
        if (!hasSNtoAcquire) {
          inEdges.push({
            id: String(inEdges.length + 1),
            source: specifyId,
            target: acquireId,
            group: nodes.find(n => n.NameID === specifyId)?.FamilyID || "",
            description: "No description",
          });
        }
      }

      // --- Validate against master CSV universe (strict subset) ---------------
      const masterNodeIds = new Set(nodes.map((n) => n.NameID));
      const masterEdgePairs = new Set(edges.map((e) => `${e.source}->${e.target}`));
      const problems: string[] = [];

      for (const n of inNodes) {
        if (!n.NameID || !masterNodeIds.has(n.NameID)) {
          problems.push(`Nodes sheet: NameID '${n.NameID || "(missing)"}' not found in All Nodes`);
        }
      }

      for (const e of inEdges) {
        const key = `${e.source}->${e.target}`;
        if (!masterEdgePairs.has(key)) {
          problems.push(`Edges sheet: pair '${key}' not found in All Edges`);
        }
      }

      if (problems.length) {
        alert("Import failed:\n" + problems.join("\n"));
        return;
      }

      // --- Commit into app state ----------------------------------------------
      setLifecycleMode("edit");
      setTitle(t);
      setDescription(d);

      // Active edges drive the "edit" mode subgraph
      const nextActive = new Set<string>();
      for (const e of inEdges) {
        if (e.source && e.target) nextActive.add(`${e.source}->${e.target}`);
      }
      setActiveEdgeKeys(nextActive);

      // Merge edge descriptions into the master edges list (non-destructive)
      const mergedEdges = edges.slice();
      for (const imp of inEdges) {
        if (!imp.source || !imp.target) continue;
        const idx = mergedEdges.findIndex((x) => x.source === imp.source && x.target === imp.target);
        if (idx >= 0) {
          mergedEdges[idx] = {
            ...mergedEdges[idx],
            description: (imp.description && imp.description.trim())
                          || mergedEdges[idx].description
                          || "No description",
          };
        }
      }
      setEdges(mergedEdges);

      // Optional per-node description overrides (keep master by default)
      const importedNodeDesc: Record<string, string> = {};
      for (const n of inNodes) {
        if (n.NameID && typeof n.Definition === "string" && n.Definition.trim()) {
          importedNodeDesc[n.NameID] = n.Definition.trim();
        }
      }
      setNodeDesc(importedNodeDesc);

      markDirty();
    } catch (err: any) {
      console.error(err);
      alert("Failed to load lifecycle: " + (err?.message || "Unknown error"));
    }
  }

  function resetLifecycle() {
    setLifecycleMode("none");
    setTitle("");
    setDescription("");
    setActiveEdgeKeys(new Set());
    clearFilters();
    markDirty();
  }

  function getLifecycleErrors(): string[] {
    const errs: string[] = [];

    if (!title.trim()) errs.push("A Title is required.");
    if (!description.trim()) errs.push("A Description is required.");

    if (!startNodeId) errs.push("The required start node 'Specify needs' was not found.");
    if (!disposeId) errs.push("The required end node 'Dispose' was not found.");
    if (!startNodeId || !disposeId) return errs;

    const reachable = bfsReachable(startNodeId, activeEdgeKeys);
    if (!reachable.has(disposeId)) errs.push("Your path must allow 'Dispose' to be reachable from 'Specify needs'.");

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
    const nodesOut = nodeIds
      .map((id) => {
        const base = nodeById[id];
        if (!base) return null;
        return { ...base, Definition: nodeDesc[id] ?? base.Definition };
      })
      .filter(Boolean) as NodeRow[];

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

  // -----------------------------
  // AUTOSAVE (debounced) & UNLOAD GUARD
  // -----------------------------
  const snapshot = useMemo<AppPersist>(() => {
    const edgeDescriptions = edges.map(e => ({
      source: e.source,
      target: e.target,
      description: e.description,
    }));

    const nodeDescriptions = Object.entries(nodeDesc).map(([NameID, Definition]) => ({
      NameID,
      Definition,
    }));

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
      nodeDescriptions,
    };
  }, [
    lifecycleMode,
    title,
    description,
    activeEdgeKeys,
    filterMode,
    selectedName,
    selectedGroup,
    legendActive,
    edges,
    nodeDesc,
  ]);

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
  // Render
  // -----------------------------
  return (
    <div className="h-screen grid grid-cols-1 lg:grid-cols-[minmax(320px,24vw)_1fr] min-h-0">
      {/* Left Pane */}
      <aside
        className={`border-r ${ui.asideBg} backdrop-blur p-4 flex flex-col gap-4 min-h-0`}
        style={{ contain: "paint" }}
      >
        {/* Title + start/edit + Examples */}
        <div className="mb-3 flex flex-col items-center gap-3 w-full">
          <h2 className="text-lg font-semibold text-center">
            Data and Information Lifecycle Builder
          </h2>

          {lifecycleMode === "none" ? (
            <>
              <div className="grid grid-cols-2 gap-3 w-full max-w-[520px]">
                <button
                  onClick={startLifecycleCreate}
                  className={`px-3 py-1.5 ${ui.btnPill}`}
                  title={uiTitle("Start a new lifecycle from scratch")}
                  aria-label="Start Custom Lifecycle"
                >
                  Start Custom Lifecycle
                </button>
                <button
                  onClick={() => fileInputRef.current?.click()}
                  className={`px-3 py-1.5 ${ui.btnPill}`}
                  title={uiTitle("Load and edit a lifecycle from an .xlsx file")}
                  aria-label="Edit Custom Lifecycle"
                >
                  Edit Custom Lifecycle
                </button>
              </div>

              {exampleFiles.length > 0 && (
                <div className="w-full max-w-[520px] grid grid-cols-[1fr_auto] gap-2">
                  <select
                    className={ui.input}
                    value={selectedExample}
                    onChange={(e) => setSelectedExample(e.target.value)}
                    title={uiTitle("Choose an example lifecycle")}
                    aria-label="Choose an example lifecycle"
                  >
                    {exampleFiles.map((e) => (
                      <option key={e.name} value={e.name}>
                        {e.name}
                      </option>
                    ))}
                  </select>
                  <button
                    className={`px-3 py-1.5 ${ui.btnPill}`}
                    onClick={() => loadExampleByName(selectedExample)}
                    title={uiTitle("Load selected example")}
                    aria-label="Load selected example"
                  >
                    Load Example
                  </button>
                </div>
              )}

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
              title={uiTitle("Cancel and discard current lifecycle changes")}
              aria-label="Cancel Custom Lifecycle"
            >
              Cancel Custom Lifecycle
            </button>
          )}
        </div>

        {/* Scrollable content */}
        <div
          ref={leftPaneRef}
          className="flex-1 min-h-0 overflow-y-auto pr-4 pb-28 overscroll-contain will-change-scroll [transform:translateZ(0)]"
          style={{ scrollbarGutter: "stable both-edges", contain: "layout paint size", paddingRight: 16 }}
        >
          {lifecycleMode !== "none" && (
            <div className="space-y-3">
              <p className={isDark ? "text-sm text-neutral-300" : "text-sm text-gray-600"}>
                Lifecycles start at <b>Specify needs</b> and end at <b>Dispose</b>. Branches may rejoin the
                main path or end at <b>Share</b>. Cycles are allowed. A lifecycle must have a <b>Title</b>{" "}
                and <b>Description</b>. Bi-directional edges require two selections.
              </p>

              <div className="grid grid-cols-1 gap-2">
                <input
                  className={ui.input}
                  placeholder="Lifecycle Title"
                  value={title}
                  onChange={(e) => {
                    setTitle(e.target.value);
                    markDirty();
                  }}
                />
                <textarea
                  className={ui.input}
                  placeholder="Lifecycle Description"
                  value={description}
                  onChange={(e) => {
                    setDescription(e.target.value);
                    markDirty();
                  }}
                  rows={3}
                />
              </div>

              <div className="mt-2">
                <div className="mb-2 flex items-center gap-2">
                  <button
                    type="button"
                    className={`px-2 py-1 text-xs ${ui.btnPill}`}
                    onClick={() => {
                      const all: Record<string, boolean> = {};
                      groups.forEach((g) => {
                        all[g] = true;
                      });
                      setOpenFamilies(all);
                    }}
                  >
                    Expand all
                  </button>
                  <button
                    type="button"
                    className={`px-2 py-1 text-xs ${ui.btnPill}`}
                    onClick={() => {
                      const all: Record<string, boolean> = {};
                      groups.forEach((g) => {
                        all[g] = false;
                      });
                      setOpenFamilies(all);
                    }}
                  >
                    Collapse all
                  </button>
                </div>

                {groups.map((fam) => (
                  <details
                    key={fam}
                    className={
                      (isDark
                        ? "border border-neutral-700 rounded-md mb-2 bg-neutral-900 shadow-sm"
                        : "border rounded-md mb-2 bg-white shadow-sm") + " contain-paint"
                    }
                    open={openFamilies[fam] ?? true}
                    onToggle={(e) => {
                      const open = (e.currentTarget as HTMLDetailsElement).open;
                      setOpenFamilies((prev) => ({ ...prev, [fam]: open }));
                    }}
                  >
                    <summary
                      className={
                        isDark
                          ? "px-3 py-2 cursor-pointer bg-neutral-800 font-medium text-sm flex items-center justify-between"
                          : "px-3 py-2 cursor-pointer bg-gray-100 font-medium text-sm flex items-center justify-between"
                      }
                    >
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
                              ref={(el) => {
                                nodeDetailsRefs.current[n.NameID] = el;
                              }}
                              className={`border rounded-md shadow-sm will-change-transform [transform:translateZ(0)] ${
                                isNodeActive
                                  ? isDark
                                    ? "bg-neutral-900 border-neutral-700"
                                    : "bg-white"
                                  : isDark
                                    ? "bg-neutral-900/70 border-neutral-700 opacity-60"
                                    : "bg-gray-50 opacity-60"
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
                                <div>
                                  <label
                                    className={
                                      isDark
                                        ? "block text-xs text-neutral-400 mb-1"
                                        : "block text-xs text-gray-600 mb-1"
                                    }
                                  >
                                    Node description (editable for this lifecycle)
                                  </label>
                                  <textarea
                                    disabled={!isNodeActive}
                                    className={`${ui.input} disabled:bg-opacity-60`}
                                    value={nodeDesc[n.NameID] ?? n.Definition}
                                    onChange={(ev) => {
                                      const v = ev.target.value;
                                      setNodeDesc((prev) => ({ ...prev, [n.NameID]: v }));
                                      markDirty();
                                    }}
                                  />
                                </div>

                                <div
                                  className="space-y-2 max-h-[45vh] overflow-y-auto pr-3 overscroll-contain will-change-scroll [transform:translateZ(0)]"
                                  style={{ contain: "layout paint size", minHeight: 160 }}
                                >
                                  <div
                                    className={
                                      isDark
                                        ? "text-xs font-semibold text-neutral-200"
                                        : "text-xs font-semibold text-gray-700"
                                    }
                                    title={uiTitle("Activate edges this node can take; destinations become part of the kept view.")}
                                  >
                                    Outgoing edges
                                  </div>

                                  {(outgoingBySource.get(n.NameID) ?? []).length === 0 && (
                                    <div
                                      className={
                                        isDark ? "text-xs text-neutral-400" : "text-xs text-gray-500"
                                      }
                                    >
                                      No outgoing edges defined for this node.
                                    </div>
                                  )}

                                  {(outgoingBySource.get(n.NameID) || []).map((e) => {
                                    const key = `${e.source}->${e.target}`;
                                    const isEdgeOn = activeEdgeKeys.has(key);
                                    const targetName = nodeById[e.target]?.Name || e.target;

                                    const canEditThisEdge =
                                      n.NameID === startNodeId || activeNodeIds.has(n.NameID);

                                    return (
                                      <div
                                        key={key}
                                        className={`border rounded-md p-2 flex flex-col gap-2 text-sm shadow-sm ${
                                          canEditThisEdge
                                            ? isDark
                                              ? "bg-neutral-900 border-neutral-700"
                                              : "bg-white"
                                            : isDark
                                              ? "bg-neutral-900/70 border-neutral-700"
                                              : "bg-gray-100"
                                        }`}
                                      >
                                        <label className="flex items-center gap-2">
                                          <input
                                            type="checkbox"
                                            className="h-4 w-4 accent-emerald-600 shrink-0"
                                            disabled={!canEditThisEdge}
                                            checked={isEdgeOn}
                                            onChange={(ev) => {
                                              const next = new Set(activeEdgeKeys);
                                              if (ev.target.checked) next.add(key);
                                              else next.delete(key);
                                              setActiveEdgeKeys(next);
                                              markDirty();
                                            }}
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
                                            const idx = edges.findIndex(
                                              (x) => x.source === e.source && x.target === e.target
                                            );
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

        {lifecycleMode !== "none" && (
          <div className={`mt-3 pt-3 border-t ${ui.divider} flex items-center gap-2`}>
            <button
              className={`px-3 py-1.5 ${ui.btnPill}`}
              title={uiTitle("Run checks to ensure your lifecycle is valid")}
              aria-label="Validate lifecycle"
              onClick={() => {
                const errs = getLifecycleErrors();
                if (errs.length === 0) alert("Lifecycle valid. You can now Save.");
                else alert("Validation failed:\n\n" + errs.join("\n"));
              }}
            >
              Validate
            </button>
            <button
              className={`px-3 py-1.5 ${ui.btnPill} disabled:opacity-50`}
              disabled={getLifecycleErrors().length > 0}
              onClick={saveLifecycle}
              title={uiTitle("Download a validated lifecycle workbook (.xlsx) you can reuse or share")}
              aria-label="Save lifecycle to XLSX"
            >
              Download Lifecycle (XLSX)
            </button>
          </div>
        )}
      </aside>

      {/* Right Pane */}
      <section className="relative">
        <GuideOverlay
          open={guideOpen || showGuide}
          isDark={isDark}
          onClose={() => {
            closeGuide();     // keeps your LS behavior
            setGuideOpen(false);
          }}
          onStart={() => {
            closeGuide();
            setGuideOpen(false);
            startLifecycleCreate();
          }}
          hasExamples={exampleFiles.length > 0}
          exampleNames={exampleFiles.map(e => e.name)}
          selectedExample={selectedExample}
          onChangeSelectedExample={setSelectedExample}
          onStartWithExample={() => {
            closeGuide();
            setGuideOpen(false);
            if (selectedExample) loadExampleByName(selectedExample);
          }}
        />

        {/* LEFT COLUMN */}
        <div
          className="
            absolute left-3 top-3 bottom-3 z-30
            w-[clamp(230px,18vw,320px)]
            flex flex-col gap-2
            pointer-events-none
          "
        >
          {/* LEFT TOP MASTER: Save/Export/Groups */}
          <div
            ref={leftTopRef}
            className={`${ui.panel} rounded-lg shadow pointer-events-auto overflow-hidden ${
              collapsed.leftTop ? "shrink-0" : "flex flex-col flex-1 min-h-0"
            }`}
          >
            <PanelHeader
              title={"Save, Export & Groups"}
              isCollapsed={collapsed.leftTop}
              onHelp={() => setMicroGuideKey("exportGroups")}
              onToggleCollapse={() => setCollapsed(p => ({ ...p, leftTop: !p.leftTop }))}
              isDark={isDark}
              uiTitle={uiTitle}
            />

            {!collapsed.leftTop && (
              <div className="flex-1 min-h-0 px-3 pb-3 overflow-y-auto space-y-2">
                {/* Save & Export subpanel */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="text-[11px] font-semibold opacity-90 mb-2">Save & Export</div>
                  <div className="grid grid-cols-2 gap-2">
                    <button className={`${ui.btnPill} py-1.5 !text-[12px] leading-tight`} onClick={exportPNG}>PNG</button>
                    <button className={`${ui.btnPill} py-1.5 !text-[12px] leading-tight`} onClick={exportSVG}>SVG</button>

                    <button className={`${ui.btnPill} py-1.5 !text-[12px] leading-tight`} onClick={exportJSON}>Download JSON</button>
                    <button className={`${ui.btnPill} py-1.5 !text-[12px] leading-tight`} onClick={() => importJsonRef.current?.click()}>
                      Load JSON
                    </button>

                    <button className={`${ui.btnPill} py-1.5 !text-[12px] col-span-2`} onClick={copyShareLink}>
                      Share Link
                    </button>
                  </div>

                  <input
                    ref={importJsonRef}
                    type="file"
                    accept=".json"
                    className="hidden"
                    onChange={(e) => e.target.files && importJSON(e.target.files[0])}
                  />
                </div>

                {/* Groups visual helper subpanel */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="text-[11px] font-semibold opacity-90 mb-2">Groups</div>

                  <div className="space-y-2">
                    {groups.map((fam) => {
                      const c = makeColorForFamily(fam);
                      const bg = c.highlight?.background ?? c.background;
                      const br = c.highlight?.border ?? c.border;

                      const famNodes =
                        nodes
                          .filter(n => canonFam(n.Family) === fam)
                          .map(n => n.Name)
                          .sort((a, b) => a.localeCompare(b));

                      return (
                        <div
                          key={fam}
                          className="rounded-md p-2"
                          style={{ background: bg, border: `2px solid ${br}` }}
                        >
                          <div className="font-semibold text-sm text-black tracking-wide text-center">
                            {fam}
                          </div>

                          <div className="h-[2px] w-full bg-black/35 my-1" />

                          <div className="text-[11px] leading-snug text-black/90 text-center break-words">
                            {famNodes.join(", ")}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* GHOST SPACER: keeps bottom pinned when top collapsed */}
          {collapsed.leftTop && <div className="flex-1 min-h-0 pointer-events-none" />}

          {/* LEFT BOTTOM MASTER: View */}
          <div
            ref={leftBottomRef}
            className={`${ui.panel} rounded-lg shadow pointer-events-auto overflow-hidden shrink-0`}
          >
            <PanelHeader
              title={"View"}
              isCollapsed={collapsed.leftBottom}
              onHelp={() => setMicroGuideKey("view")}
              onToggleCollapse={() => setCollapsed(p => ({ ...p, leftBottom: !p.leftBottom }))}
              isDark={isDark}
              uiTitle={uiTitle}
            />

            {!collapsed.leftBottom && (
              <div className="px-3 pb-3 flex flex-col gap-2">
                {/* 1) View */}
                <SubPanel title={"View"}>
                  <div className="grid grid-cols-3 gap-2">
                    <div />
                    <HoldButton onHold={() => pan(0, PAN_STEP)} className={ui.btnPill}>↑</HoldButton>
                    <div />
                    <HoldButton onHold={() => pan(PAN_STEP, 0)} className={ui.btnPill}>←</HoldButton>
                    <HoldButton onHold={() => pan(0, -PAN_STEP)} className={ui.btnPill}>↓</HoldButton>
                    <HoldButton onHold={() => pan(-PAN_STEP, 0)} className={ui.btnPill}>→</HoldButton>
                  </div>
                </SubPanel>

                {/* 2) Toggle */}
                <SubPanel title={"Toggle"}>
                  <div className="flex items-center gap-2">
                    <label className={`flex items-center gap-2 text-xs ${filterMode !== null ? "opacity-50 cursor-not-allowed" : ""}`}>
                      <input
                        type="checkbox"
                        checked={dragNodes}
                        disabled={filterMode !== null}
                        onChange={(e) => setDragNodes(e.target.checked)}
                      />
                      Drag nodes
                    </label>

                    <label className="flex items-center gap-2 text-xs">
                      <input
                        type="checkbox"
                        checked={tooltipsOn}
                        onChange={(e) => setTooltipsOn(e.target.checked)}
                      />
                      Tooltips
                    </label>

                    <button
                      type="button"
                      className={`${ui.btnPill} h-7 px-2 !text-[12px] leading-tight`}
                      onClick={resetViewOnly}
                      title={uiTitle("Reset view and Fit")}
                      aria-label="Reset view"
                    >
                      Reset
                    </button>
                  </div>
                </SubPanel>

                {/* 3) Edge Mode */}
                <SubPanel title={"Edge Mode"}>
                  <div className="flex flex-col gap-1 text-xs">
                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="edgeMode"
                        checked={edgeMode === "default"}
                        onChange={() => setEdgeMode("default")}
                      />
                      Default (anti-pierce)
                    </label>

                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="edgeMode"
                        checked={edgeMode === "straight"}
                        onChange={() => setEdgeMode("straight")}
                      />
                      Straight
                    </label>

                    <label className="flex items-center gap-2">
                      <input
                        type="radio"
                        name="edgeMode"
                        checked={edgeMode === "curved"}
                        onChange={() => setEdgeMode("curved")}
                      />
                      Curved
                    </label>
                  </div>
                </SubPanel>
              </div>
            )}
          </div>
        </div>

        {/* RIGHT COLUMN */}
        <div
          className="
            absolute right-3 top-3 bottom-3 z-30
            w-[clamp(200px,15vw,260px)]
            flex flex-col gap-2
            pointer-events-none
          "
        >
          {/* RIGHT TOP MASTER: Filters */}
          <div
            ref={rightTopRef}
            className={`${ui.panel} rounded-lg shadow pointer-events-auto overflow-hidden ${
              collapsed.rightTop ? "shrink-0" : "flex flex-col flex-1 min-h-0"
            }`}
          >
            <PanelHeader
              title={"Filters"}
              isCollapsed={collapsed.rightTop}
              isDark={isDark}
              onHelp={() => setMicroGuideKey("filters")}
              onClear={clearFilters}
              onToggleCollapse={() => setCollapsed((p) => ({ ...p, rightTop: !p.rightTop }))}
              uiTitle={uiTitle}
            />


            {!collapsed.rightTop && (
              <div className="flex-1 min-h-0 px-3 pb-3 overflow-y-auto space-y-2">
                {/* Select by Name */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="text-[11px] font-semibold opacity-90 mb-2">Select by Name</div>

                  <select
                    className={ui.input}
                    value={selectedName}
                    onChange={(e) => setSelectedName(e.target.value)}
                  >
                    <option value="">Choose a node…</option>
                    {(lifecycleMode === "none"
                      ? nodes
                      : nodes.filter(n => activeNodeIds.has(n.NameID))
                    )
                      .slice()
                      .sort((a, b) => a.Name.localeCompare(b.Name))
                      .map(n => (
                        <option key={n.NameID} value={n.Name}>{n.Name}</option>
                      ))}
                  </select>

                  <button
                    className={`${ui.btnPill} w-full mt-2 py-2 text-sm disabled:opacity-50`}
                    disabled={!selectedName}
                    onClick={() => applySelectByName(selectedName)}
                  >
                    Apply
                  </button>
                </div>

                {/* Select by Group */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="text-[11px] font-semibold opacity-90 mb-2">Select by Group</div>

                  <select
                    className={ui.input}
                    value={selectedGroup}
                    onChange={(e) => setSelectedGroup(e.target.value)}
                  >
                    <option value="">Choose a group…</option>
                    {(lifecycleMode === "none" ? groups : visibleFamilies).map(fam => (
                      <option key={fam} value={fam}>{fam}</option>
                    ))}
                  </select>

                  <button
                    className={`${ui.btnPill} w-full mt-2 py-2 text-sm disabled:opacity-50`}
                    disabled={!selectedGroup}
                    onClick={() => applySelectByGroup(selectedGroup)}
                  >
                    Apply
                  </button>
                </div>

                {/* Legend */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="flex items-center justify-between mb-2">
                    <div className="text-[11px] font-semibold opacity-90">Legend</div>
                  </div>

                  <div className="space-y-2">
                    {(lifecycleMode === "none" ? groups : visibleFamilies).map((fam) => {
                      const c = makeColorForFamily(fam);
                      return (
                        <button
                          key={fam}
                          className="w-full rounded-md px-3 py-2 !text-[12px] leading-none font-semibold tracking-wide truncate whitespace-nowrap overflow-hidden"
                          style={{ background: c.background, border: `2px solid ${c.border}`, color: "#000" }}
                          onClick={() => applySelectByGroup(fam)}
                        >
                          {fam}
                        </button>
                      );
                    })}
                  </div>
                </div>
              </div>
            )}
          </div>

          {/* GHOST SPACER */}
          {collapsed.rightTop && <div className="flex-1 min-h-0 pointer-events-none" />}

          {/* RIGHT BOTTOM MASTER: Label Size, Zoom & Help */}
          <div
            ref={rightBottomRef}
            className={`${ui.panel} rounded-lg shadow pointer-events-auto overflow-hidden shrink-0`}
          >
            <PanelHeader
              title={"Label Size, Zoom & Help"}
              isCollapsed={collapsed.rightBottom}
              onFit={fitUsable}
              onHelp={() => setMicroGuideKey("zoom")}
              onToggleCollapse={() => setCollapsed(p => ({ ...p, rightBottom: !p.rightBottom }))}
              isDark={isDark}
              uiTitle={uiTitle}
            />

            {!collapsed.rightBottom && (
              <div className="px-3 pb-3 flex flex-col gap-2">
                {/* Label Size */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="text-[11px] font-semibold opacity-90 mb-2">Label Size</div>
                  <div className="flex items-center gap-3">
                    <input
                      type="range"
                      min={9}
                      max={22}
                      value={fontPx}
                      onChange={(e) => setFontPx(Number(e.target.value))}
                      className="w-full"
                    />
                    <div className="text-xs opacity-90 w-[42px] text-right">{fontPx}px</div>
                  </div>
                </div>

                {/* Zoom */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="text-[11px] font-semibold opacity-90 mb-2">Zoom</div>
                  <div className="grid grid-cols-2 gap-2">
                    <HoldButton className={ui.btnPill} onHold={() => zoomIn(1.01)} title={uiTitle("Zoom In")}>+</HoldButton>
                    <HoldButton className={ui.btnPill} onHold={() => zoomOut(1.01)} title={uiTitle("Zoom Out")}>−</HoldButton>
                  </div>
                </div>

                {/* Help (re-open overlays) */}
                <div className="rounded-md border border-white/10 p-2">
                  <div className="text-[11px] font-semibold opacity-90 mb-2">Help</div>
                  <div className="gap-2">
                    <button className={`${ui.btnPill} py-1.5 text-[11px]`} onClick={() => setShowGuide(true)}>
                      Open Guide
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>

        {microGuideKey !== null && (
          <MicroGuideOverlay
            open={true}
            isDark={isDark}
            guideKey={microGuideKey}
            onClose={() => setMicroGuideKey(null)}
          />
        )}

        {/* Graph canvas */}
        <div ref={containerRef} className="w-full h-[calc(100vh-0px)]" />
      </section>
    </div>
  );
}

function SubPanel({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <div className="rounded-md border border-white/10 p-2">
      <div className="text-[11px] font-semibold opacity-90 mb-2">{title}</div>
      {children}
    </div>
  );
}

/** Small hold-to-repeat button helper using the global controller */
function HoldButton({
  className,
  onHold,
  children,
  title,
  ariaLabel,
}: {
  className?: string;
  onHold: () => void;
  children: any;
  title?: string;
  ariaLabel?: string;
}) {
  return (
    <button
      className={className}
      title={title}
      aria-label={ariaLabel || title}
      onMouseDown={() => beginHold(onHold)}
      onMouseUp={stopHold}
      onMouseLeave={stopHold}
      onTouchStart={() => beginHold(onHold)}
      onTouchEnd={stopHold}
    >
      {children}
    </button>
  );
}

function PanelHeader({
  title,
  isCollapsed,
  onToggleCollapse,
  onHelp,
  onFit,
  onClear,
  isDark,
  uiTitle, // NEW
}: {
  title: string;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  onHelp: () => void;
  onFit?: () => void;
  onClear?: () => void;
  isDark: boolean;
  uiTitle?: (s: string) => string | undefined; // NEW
}) {
  const iconBtn = [
    "h-7 w-7 rounded-md border flex items-center justify-center select-none",
    isDark
      ? "bg-black text-white border-neutral-700 hover:opacity-90"
      : "bg-white text-black border-neutral-300 hover:bg-neutral-50",
  ].join(" ");

  const smallBtn = [
    "h-7 !px-1 rounded-md border !text-[12px] font-semibold select-none",
    "flex items-center justify-center",
    isDark
      ? "bg-black text-white border-neutral-700 hover:opacity-90"
      : "bg-white text-black border-neutral-300 hover:bg-neutral-50",
  ].join(" ");

  const stop = (fn: () => void) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    fn();
  };

  return (
    <div className="flex items-center justify-between gap-2 px-3 py-2">
      <div className="text-xs font-semibold opacity-90">{title}</div>

      <div className="flex items-center gap-2">
        {onFit && (
          <button
            type="button"
            className={iconBtn}
            title={uiTitle ? uiTitle("Fit") : "Fit"}
            aria-label="Fit"
            onClick={stop(onFit)}
          >
            ⤢
          </button>
        )}

        {onClear && (
          <button
            type="button"
            className={smallBtn}
            title={uiTitle ? uiTitle("Clear Filters") : "Clear Filters"}
            aria-label="Clear Filters"
            onClick={stop(onClear)}
          >
            Clear
          </button>
        )}

        <button
          type="button"
          className={iconBtn}
          title={uiTitle ? uiTitle("Help") : "Help"}
          aria-label="Help"
          onClick={stop(onHelp)}
        >
          ⓘ
        </button>

        <button
          type="button"
          className={iconBtn}
          title={uiTitle ? uiTitle(isCollapsed ? "Expand" : "Collapse") : (isCollapsed ? "Expand" : "Collapse")}
          aria-label={isCollapsed ? "Expand" : "Collapse"}
          onClick={stop(onToggleCollapse)}
        >
          {isCollapsed ? "▾" : "▴"}
        </button>
      </div>
    </div>
  );
}