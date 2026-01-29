import { useMemo } from "react";

export type MicroGuideKey = "exportGroups" | "filters" | "view" | "zoom";

export default function MicroGuideOverlay({
  open,
  isDark,
  guideKey,
  onClose,
}: {
  open: boolean;
  isDark: boolean;
  guideKey: MicroGuideKey;
  onClose: () => void;
}) {
  const panel = isDark
    ? "bg-neutral-900/95 text-white border border-neutral-700"
    : "bg-white/95 text-black border border-neutral-200";

  const subtle = isDark ? "text-neutral-300" : "text-neutral-600";
  const btn = isDark
    ? "rounded-md bg-black text-white border border-neutral-700 hover:opacity-90"
    : "rounded-md bg-white text-black border border-neutral-300 hover:bg-neutral-50";

  const content = useMemo(() => {
    switch (guideKey) {
      case "exportGroups":
        return {
          title: "Save, Export & Groups",
          bullets: [
            "Export PNG/SVG to share a snapshot of the current graph.",
            "Download/Load State (JSON) saves your in-progress work and lets you resume later.",
            "Groups shows the official lifecycle families and their nodes.",
          ],
          tip: "Tip: In Custom/Edit mode, the graph shows only active nodes/edges — Groups helps you confirm what exists overall.",
        };

      case "filters":
        return {
          title: "Filters",
          bullets: [
            "Select by Name keeps the node + its outgoing edges + destinations.",
            "Select by Group keeps that family’s nodes and their outgoing edges.",
            "Filters are mutually exclusive to avoid mixed states.",
          ],
          tip: "Tip: Use Clear Filters to restore the full view quickly.",
        };

      case "view":
        return {
          title: "View (Pan)",
          bullets: [
            "Use arrows (or arrow keys) to pan the graph precisely.",
            "Hold buttons to continuously pan.",
          ],
          tip: "Tip: If you get lost, use Fit in the Zoom panel to recenter to the usable area.",
        };

      case "zoom":
        return {
          title: "Label Size, Zoom & Help",
          bullets: [
            "Label size changes node label + tooltip readability.",
            "Zoom controls scale; Fit centers the graph into the usable area between panels.",
            "Help opens guidance (this tool + panel micro guides).",
          ],
          tip: "Tip: If Fit feels off, it’s usually because panels were resized/collapsed and the usable area changed.",
        };

      default:
        // should never happen (guideKey is a union), but keeps TS happy if you refactor later
        return { title: "Help", bullets: [], tip: "" };
    }
  }, [guideKey]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[80] flex items-center justify-center px-4"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      <div className="absolute inset-0 bg-black/25" onClick={onClose} aria-hidden="true" />

      <div className={`relative w-full max-w-[520px] rounded-xl shadow-xl ${panel}`}>
        <div className="p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-lg font-semibold">{content.title}</div>
              <div className={`mt-1 text-sm ${subtle}`}>Micro guide</div>
            </div>

            <button
              type="button"
              onClick={onClose}
              className={`h-9 w-9 rounded-md ${btn} flex items-center justify-center leading-none`}
              aria-label="Close"
              title="Close"
            >
              <span className="text-lg leading-none">✕</span>
            </button>
          </div>

          <div className="mt-4 text-sm">
            <ul className={`list-disc pl-5 space-y-2 ${subtle}`}>
              {content.bullets.map((b, i) => (
                <li key={i}>{b}</li>
              ))}
            </ul>

            {content.tip && <div className={`mt-3 text-xs ${subtle}`}>{content.tip}</div>}
          </div>
        </div>
      </div>
    </div>
  );
}
