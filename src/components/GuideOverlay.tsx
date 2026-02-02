import React, { useMemo, useState } from "react";

type GuideOverlayProps = {
  open: boolean;
  isDark: boolean;
  onClose: () => void;
  onStart: () => void;

  // Example support
  hasExamples: boolean;
  exampleNames: string[];
  selectedExample: string;
  onChangeSelectedExample: (name: string) => void;
  onStartWithExample: () => void;
};

type Page = {
  key: string;
  title: string;
  subtitle?: string;
  body: React.ReactNode;
};

export default function GuideOverlay(props: GuideOverlayProps) {
  const {
    open,
    isDark,
    onClose,
    onStart,
    hasExamples,
    exampleNames,
    selectedExample,
    onChangeSelectedExample,
    onStartWithExample,
  } = props;

  const [pageIdx, setPageIdx] = useState(0);

  const panel = isDark
    ? "bg-neutral-900/95 text-white border border-neutral-700"
    : "bg-white/95 text-black border border-neutral-200";

  const subtle = isDark ? "text-neutral-300" : "text-neutral-600";
  const btn = isDark
    ? "rounded-md bg-black text-white border border-neutral-700 hover:opacity-90"
    : "rounded-md bg-white text-black border border-neutral-300 hover:bg-neutral-50";

  const dotBase = isDark
  ? "h-2.5 w-2.5 rounded-full border border-neutral-600"
  : "h-2.5 w-2.5 rounded-full border border-neutral-300";

  const dotOn = isDark ? "!bg-white" : "!bg-black";
  const dotOff = isDark ? "!bg-neutral-800" : "!bg-neutral-200";

  const pages: Page[] = useMemo(
    () => [
      {
        key: "workflow",
        title: "Lifecycle Builder",
        subtitle: "Quick start",
        body: (
          <div className="space-y-3">
            <div>
              <div className="font-semibold">Typical workflow</div>
              <div className={subtle}>
                Start building → Select nodes and edges → Validate → Download or Share.
              </div>
            </div>

            <div>
              <div className="font-semibold">What this tool does</div>
              <div className={subtle}>
                Build a data & information lifecycle by selecting edges between nodes,
                validate it, and export a reusable artifact.
              </div>
            </div>

            <div>
              <div className="font-semibold">How to use it</div>
              <ul className={`mt-1 list-disc pl-5 ${subtle}`}>
                <li>
                  Start from <b>Specify needs</b> and choose outgoing edges to build your lifecycle.
                </li>
                <li>
                  Use <b>Validate</b> to check rules (Dispose reachable, valid endpoints, etc.).
                </li>
                <li>
                  Use <b>Download</b> or <b>Share Link</b> to save your work.
                </li>
                <li>
                  Use <b>Drag nodes</b> to manually reposition nodes, <b>Reset</b> to restore defaults, and <b>Edge Mode</b> to control edge styling.
                </li>
                <li>
                  <b>Tooltips</b> toggles help text across the whole app (graph + UI).
                </li>
              </ul>
            </div>
          </div>
        ),
      },

      {
        key: "modes",
        title: "Custom lifecycle modes",
        subtitle: "Create vs Edit",
        body: (
          <div className="space-y-3">
            <div>
              <div className="font-semibold">Start Custom Lifecycle</div>
              <div className={subtle}>
                Start from scratch, select edges, and build a lifecycle step-by-step.
              </div>
            </div>

            <div>
              <div className="font-semibold">Edit Custom Lifecycle</div>
              <div className={subtle}>
                Load an existing lifecycle workbook (.xlsx) and modify it safely.
              </div>
            </div>

            <div>
              <div className="font-semibold">Explore mini guides</div>
              <div className={subtle}>
                Look for the <b>ⓘ</b> icons on panels (Export/Groups/Filters/View/Zoom). Each opens a
                short “what it does + how to use it” guide.
              </div>
            </div>
          </div>
        ),
      },

      {
        key: "faq",
        title: "FAQ",
        subtitle: "Common questions",
        body: (
          <div className="space-y-3">
            <div>
              <div className="font-semibold">Why did Fit move the graph?</div>
              <div className={subtle}>
                Fit uses the current “usable area” (space between panels). If panels change size or
                collapse, the usable area changes too.
              </div>
            </div>

            <div>
              <div className="font-semibold">Why is an edge disabled or missing?</div>
              <div className={subtle}>
                In custom mode, only reachable (active) nodes/edges are shown. Start from{" "}
                <b>Specify needs</b> and activate outgoing edges to expand the view.
              </div>
            </div>

            <div>
              <div className="font-semibold">Why did my filters reset?</div>
              <div className={subtle}>
                Filters are mutually exclusive by design to prevent mixed states. Selecting a Name
                clears Group filters (and vice-versa). Use <b>Clear Filters</b> to restore defaults.
              </div>
            </div>
          </div>
        ),
      },
    ],
    [subtle]
  );

  const page = pages[Math.max(0, Math.min(pageIdx, pages.length - 1))];

  if (!open) return null;

  const canPrev = pageIdx > 0;
  const canNext = pageIdx < pages.length - 1;

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center px-4" aria-modal="true" role="dialog">
      <div className="absolute inset-0 bg-black/20" onClick={onClose} aria-hidden="true" />

      <div
        className={`relative w-full max-w-[760px] rounded-xl shadow-xl ${panel}`}
        style={{
          transform: "scale(clamp(0.85, 1vw + 0.8, 1))",
          transformOrigin: "center",
        }}
      >
        <div className="p-5 sm:p-6">
          {/* Header */}
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xl font-semibold">{page.title}</div>
              {page.subtitle && <div className={`mt-1 text-sm ${subtle}`}>{page.subtitle}</div>}
            </div>

            <button
              type="button"
              onClick={onClose}
              className={`h-9 w-9 rounded-md ${btn} flex items-center justify-center leading-none`}
              aria-label="Close guide"
              title="Close"
            >
              <span className="text-lg leading-none">✕</span>
            </button>
          </div>

          {/* Body */}
          <div className="mt-4 text-sm leading-relaxed">{page.body}</div>

          {/* Pager */}
          <div className="mt-5 flex items-center justify-center gap-4">
            {/* Back */}
            <button
                type="button"
                className={`px-3 py-2 ${btn} disabled:opacity-50`}
                disabled={!canPrev}
                onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
                title="Previous"
            >
                ← Back
            </button>

            {/* Page indicators */}
            <div className="flex items-center gap-2">
                {pages.map((p, i) => (
                <button
                    key={p.key}
                    type="button"
                    className={`${dotBase} ${i === pageIdx ? dotOn : dotOff}`}
                    onClick={() => setPageIdx(i)}
                    aria-label={`Go to page ${i + 1}`}
                    title={`Page ${i + 1}`}
                />
                ))}
            </div>

            {/* Next */}
            <button
                type="button"
                className={`px-3 py-2 ${btn} disabled:opacity-50`}
                disabled={!canNext}
                onClick={() => setPageIdx((i) => Math.min(pages.length - 1, i + 1))}
                title="Next"
            >
                Next →
            </button>
          </div>

          {/* Start options (always visible, below dots) */}
          <div className="mt-4 pt-4 border-t border-white/10">
            <div className="font-semibold mb-2">Start options</div>

            <div className="flex flex-wrap items-stretch gap-2">
              <button type="button" className={`px-3 py-2 ${btn}`} onClick={onStart}>
                Start Building
              </button>

              <button type="button" className={`px-3 py-2 ${btn}`} onClick={onClose}>
                Continue to Tool
              </button>

              {/* Rightmost: Start with example + dropdown */}
              <div className="ml-auto flex items-stretch gap-2">
                <select
                  className={`${btn} px-3 py-2`}
                  style={{ minWidth: 220 }}
                  disabled={!hasExamples}
                  value={selectedExample}
                  onChange={(e) => onChangeSelectedExample(e.target.value)}
                  title={hasExamples ? "Choose an example" : "No examples found"}
                >
                  {hasExamples ? (
                    exampleNames.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))
                  ) : (
                    <option value="">No examples</option>
                  )}
                </select>

                <button
                  type="button"
                  className={`px-3 py-2 ${btn} disabled:opacity-50`}
                  onClick={onStartWithExample}
                  disabled={!hasExamples}
                  title={hasExamples ? "Start with the selected example" : "No examples found"}
                >
                  Start with example
                </button>
              </div>
            </div>

            <div className={`mt-2 text-xs ${subtle}`}>
              Tip: Panel <b>ⓘ</b> icons open quick “micro guides” for that component.
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}