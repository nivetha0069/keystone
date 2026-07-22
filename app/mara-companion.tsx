"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { MaraSection } from "./lib/cmdb/mara-companion-state";
import type {
  MaraActionKey,
  MaraLive,
  MaraVisualState,
  WorkspaceViewState,
} from "./lib/cmdb/workspace-view-state";
import { useDraggableMascot } from "./lib/ui/use-draggable-mascot";

const MUTE_STORAGE_KEY = "keystone.mara.muted";
// The bubble opens only when the user clicks Mara, and auto-collapses after
// this idle interval unless it is hovered or holds focus.
const AUTO_COLLAPSE_MS = 12000;

export type MaraCompanionProps = {
  activeRunId: string;
  activeRunLabel: string;
  view: WorkspaceViewState;
  onNavigate: (section: MaraSection) => void;
  onOpenLedger: () => void;
  onOpenApprovals?: () => void;
  onOpenRemediation?: () => void;
  onShowReviewQueue: () => void;
};

type MaraAction = { key: MaraActionKey; label: string; onSelect: () => void };

export function MaraCompanion(props: MaraCompanionProps) {
  const {
    activeRunId, activeRunLabel, view,
    onNavigate, onOpenLedger, onOpenApprovals, onOpenRemediation, onShowReviewQueue,
  } = props;

  // Single source of truth: Mara only ever reflects the live workspace view,
  // so the mascot cannot show stale or divergent ("false") state.
  const live: MaraLive = view.mara;

  const actions = useMemo<MaraAction[]>(() => {
    const aiUsageHref = activeRunId
      ? `/ai-usage?run=${encodeURIComponent(activeRunId)}`
      : "/ai-usage";
    const goAiUsage = () => { window.location.assign(aiUsageHref); };
    const openApprovals = () => (onOpenApprovals ? onOpenApprovals() : onNavigate("remediate"));
    const openRemediation = () => (onOpenRemediation ? onOpenRemediation() : onNavigate("remediate"));

    const build = (key: MaraActionKey): MaraAction | null => {
      switch (key) {
        case "start_rescue":
          return activeRunId ? null : { key, label: "Start a rescue", onSelect: () => onNavigate("import") };
        case "watch_activity":
          return { key, label: "Watch activity", onSelect: () => onNavigate("live") };
        case "review_findings": return { key, label: "Review findings", onSelect: () => onShowReviewQueue() };
        case "open_approvals": return { key, label: "Open approvals", onSelect: openApprovals };
        case "open_remediation": return { key, label: "Open remediation", onSelect: openRemediation };
        case "open_evidence": return { key, label: "View evidence", onSelect: () => onOpenLedger() };
        case "open_ai_usage": return { key, label: "AI usage", onSelect: goAiUsage };
        case "inspect_run": return { key, label: "Inspect the run", onSelect: () => onNavigate("comprehend") };
      }
    };

    return live.actions
      .map(build)
      .filter((a): a is MaraAction => Boolean(a));
  }, [live.actions, activeRunId, onNavigate, onOpenLedger, onOpenApprovals, onOpenRemediation, onShowReviewQueue]);

  const [muted, setMuted] = useState<boolean>(() => {
    try {
      if (typeof window === "undefined") return false;
      return window.localStorage.getItem(MUTE_STORAGE_KEY) === "1";
    } catch { return false; }
  });
  const [open, setOpen] = useState(false);
  const [openedAt, setOpenedAt] = useState(0);
  const autoCloseTimerRef = useRef<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    try {
      if (typeof window === "undefined") return;
      if (muted) window.localStorage.setItem(MUTE_STORAGE_KEY, "1");
      else window.localStorage.removeItem(MUTE_STORAGE_KEY);
    } catch { /* ignore */ }
  }, [muted]);

  const scheduleAutoClose = useCallback(() => {
    setOpenedAt(value => value + 1);
  }, []);

  const openBubble = useCallback(() => {
    setOpen(true);
    setOpenedAt(value => value + 1);
  }, []);

  useEffect(() => {
    if (!open || openedAt === 0) return;
    if (autoCloseTimerRef.current !== null) window.clearTimeout(autoCloseTimerRef.current);
    autoCloseTimerRef.current = window.setTimeout(() => {
      const node = bubbleRef.current;
      const active = typeof document !== "undefined" ? document.activeElement : null;
      const hovered = node?.matches(":hover") ?? false;
      const focusInside = node && active instanceof Node ? node.contains(active) : false;
      if (hovered || focusInside) {
        setOpenedAt(value => value + 1);
        return;
      }
      setOpen(false);
    }, AUTO_COLLAPSE_MS);
    return () => {
      if (autoCloseTimerRef.current !== null) window.clearTimeout(autoCloseTimerRef.current);
    };
  }, [open, openedAt]);

  const { containerRef, style, onPointerDown, onKeyDown, resetPosition, wasDragged, isMobile, debug } = useDraggableMascot();
  const debugOn = typeof process !== "undefined" && process.env?.NODE_ENV !== "production"
    && typeof window !== "undefined"
    && (window.location?.search?.includes("mara-debug=1") ?? false);

  const visualState: MaraVisualState = live.visualState;
  const stateSlug = visualState.replace("_", "-");
  const emphasis = !muted && open ? " mara-emphasis" : "";
  const openClass = open ? " mara-open" : "";
  const mobileClass = isMobile ? " mara-mobile" : "";
  const label = live.headline;

  return (
    <div
      ref={containerRef}
      className={`mara-companion mara-${stateSlug}${emphasis}${muted ? " mara-muted" : ""}${openClass}${mobileClass}`}
      data-state={live.state}
      data-visual-state={visualState}
      style={style}
    >
      {open && (
        <div
          ref={bubbleRef}
          className="mara-bubble"
          data-mara-no-drag=""
          role="dialog"
          aria-label={`Mara says: ${live.message}`}
          onMouseEnter={scheduleAutoClose}
          onFocus={scheduleAutoClose}
        >
          <div className="mara-bubble-top">
            <div>
              <span className="mara-eyebrow">CMDB COMPANION</span>
              <strong className="mara-name">Mara</strong>
            </div>
            <div className="mara-bubble-controls" data-mara-no-drag="">
              <button
                type="button"
                className="mara-mute"
                aria-pressed={muted}
                aria-label={muted ? "Unmute Mara" : "Mute Mara"}
                title={muted ? "Unmute Mara" : "Mute Mara"}
                onClick={() => setMuted(value => !value)}
              >
                {muted ? "Unmute" : "Mute"}
              </button>
              <button
                type="button"
                className="mara-reset"
                aria-label="Reset Mara position"
                title="Reset Mara position"
                onClick={resetPosition}
              >⤾</button>
              <button
                type="button"
                className="mara-close"
                aria-label="Collapse Mara"
                onClick={() => setOpen(false)}
              >×</button>
            </div>
          </div>
          <div className="mara-bubble-body">
            <p className="mara-primary">{live.message}</p>
            {live.secondary && <p className="mara-secondary">{live.secondary}</p>}
            {view && <MaraInsights view={view} />}
            <p className="mara-status" aria-live="polite">
              <span className={`mara-status-dot mara-status-${stateSlug}`} aria-hidden="true" />
              <span>{label}{activeRunLabel ? ` · ${activeRunLabel}` : ""}</span>
            </p>
          </div>
          {actions.length > 0 && (
            <div className="mara-bubble-actions" data-mara-no-drag="">
              {actions.slice(0, 2).map(action => (
                <button
                  key={action.key}
                  type="button"
                  className="mara-action"
                  onClick={() => { action.onSelect(); }}
                >
                  {action.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
      <button
        type="button"
        className="mara-toggle"
        aria-label={open ? "Collapse Mara companion" : `Open Mara companion. ${label}.`}
        aria-expanded={open}
        title={`Mara — ${label}. Drag to move, arrow keys to nudge.`}
        onPointerDown={onPointerDown}
        onKeyDown={onKeyDown}
        onClick={event => {
          // Suppress the click if it followed a drag.
          if (wasDragged) { event.preventDefault(); return; }
          if (open) setOpen(false);
          else openBubble();
        }}
      >
        <MaraLotusSvg state={visualState} />
      </button>
      {debugOn && (
        <div className="mara-debug" data-mara-no-drag="" aria-hidden="true">
          <div>x {Math.round(debug.x)} · y {Math.round(debug.y)}</div>
          <div>vp {debug.viewportWidth}×{debug.viewportHeight}</div>
          <div>drag {debug.dragging ? "yes" : "no"} · z {debug.zIndex}</div>
          <div>mounted {debug.mounted ? "yes" : "no"} · state {live.state}</div>
        </div>
      )}
    </div>
  );
}

function MaraInsights({ view }: { view: WorkspaceViewState }) {
  const chips: Array<{ label: string; value: string; tone?: string }> = [];
  if (view.workGroupCount > 0) chips.push({ label: "Groups", value: String(view.workGroupCount) });
  if (view.approvalCount > 0) chips.push({ label: "Approvals", value: String(view.approvalCount), tone: "warn" });
  if (view.heldCount > 0 && view.approvalCount === 0) chips.push({ label: "Held", value: String(view.heldCount), tone: "warn" });
  const executing = view.queue.items.filter(i => i.bucket === "needs_verification").length;
  const verified = view.queue.items.filter(i => i.bucket === "verified").length;
  if (executing > 0) chips.push({ label: "Executing", value: String(executing) });
  if (verified > 0) chips.push({ label: "Verified", value: String(verified), tone: "good" });
  if (view.readyToSimulateCount > 0 && view.remediateStatus !== "working") chips.push({ label: "Ready", value: String(view.readyToSimulateCount) });
  if (!chips.length && view.hasRun && view.queue.items.length > 0) chips.push({ label: "Staged", value: String(view.queue.items.length) });
  if (!chips.length) return null;
  return <ul className="mara-insights" aria-label="Run insights">
    {chips.slice(0, 4).map(chip => (
      <li key={chip.label} className={"mara-insight " + (chip.tone ?? "")}>
        <small>{chip.label}</small>
        <strong>{chip.value}</strong>
      </li>
    ))}
  </ul>;
}

// Pixel-art Mara: a chunky lotus mascot built on a 22x22 grid of solid cells,
// painted in the app's lime/green theme so she reads clearly on the dark UI.
// The grid is generated from symmetric ellipse math, so the sprite stays
// pixel-crisp and perfectly mirrored.
const MARA_PIX: Record<string, string> = {
  O: "#0b0f08", // outline / dark
  L: "#c7f34d", // lime petal (--lime)
  D: "#8fbf3a", // petal shade
  F: "#eef6d8", // pale face
  G: "#5fca90", // leaf base (--green-ish)
  E: "#0b0f08", // eyes
  g: "#3f7d5c", // mouth
  c: "#b5e35a", // cheeks
};

const MARA_GRID = 22;

function buildMaraPixels(state: MaraVisualState): string[][] {
  const N = MARA_GRID;
  const grid: string[][] = Array.from({ length: N }, () => Array<string>(N).fill("."));
  const inb = (x: number, y: number) => x >= 0 && x < N && y >= 0 && y < N;
  const put = (x: number, y: number, k: string) => { if (inb(x, y)) grid[y][x] = k; };
  const ell = (cx: number, cy: number, rx: number, ry: number, k: string) => {
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const dx = (x + 0.5 - cx) / rx, dy = (y + 0.5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) grid[y][x] = k;
    }
  };
  const sleeping = state === "sleeping";
  const error = state === "error";

  // Petals (dark outline, then lime, with a shaded lower band).
  ell(11, 6.5, 3.2, 4.8, "O"); ell(6.6, 8.5, 3.0, 3.9, "O"); ell(15.4, 8.5, 3.0, 3.9, "O");
  ell(11, 6.5, 2.4, 4.0, "L"); ell(6.6, 8.5, 2.2, 3.1, "L"); ell(15.4, 8.5, 2.2, 3.1, "L");
  ell(11, 8.6, 2.2, 2.0, "D");
  // Head bulb (dark outline ring + pale face).
  ell(11, 13, 7.0, 6.9, "O"); ell(11, 13, 6.1, 6.0, "F");
  // Leaf cradle at the base.
  ell(11, 19.3, 5.6, 2.7, "O"); ell(11, 19.3, 4.7, 1.9, "G");
  // Round glasses: a 3x3 dark ring around each eye, cleared centre, bridge.
  for (const ex of [8, 13]) {
    for (let x = ex - 1; x <= ex + 1; x++) for (let y = 11; y <= 13; y++) put(x, y, "O");
    put(ex, 12, "F");
  }
  put(10, 12, "O"); put(11, 12, "O"); // bridge
  // Eyes.
  if (sleeping) { put(8, 12, "O"); put(13, 12, "O"); }
  else { put(8, 12, "E"); put(13, 12, "E"); }
  // Cheeks.
  if (!sleeping && !error) { put(7, 15, "c"); put(14, 15, "c"); }
  // Mouth.
  if (error) { put(10, 16, "g"); put(11, 16, "g"); put(9, 17, "g"); put(12, 17, "g"); }
  else if (sleeping) { put(10, 16, "g"); put(11, 16, "g"); }
  else { put(9, 16, "g"); put(12, 16, "g"); put(10, 17, "g"); put(11, 17, "g"); }

  return grid;
}

function MaraLotusSvg({ state }: { state: MaraVisualState }) {
  const grid = useMemo(() => buildMaraPixels(state), [state]);
  const halo = state === "error" ? "#ff6542"
    : state === "warning" || state === "awaiting_approval" ? "#e8b23d"
      : state === "sleeping" ? "#59c58b"
        : state === "blooming" ? "#7bd8a2"
          : "#c7f34d";

  return (
    <svg
      className={`mara-svg mara-svg-${state.replace("_", "-")}`}
      viewBox="-1 -1 24 24"
      xmlns="http://www.w3.org/2000/svg"
      shapeRendering="crispEdges"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="mara-halo" cx="50%" cy="50%" r="52%">
          <stop offset="0%" stopColor={halo} stopOpacity="0.5" />
          <stop offset="55%" stopColor={halo} stopOpacity="0.22" />
          <stop offset="100%" stopColor={halo} stopOpacity="0" />
        </radialGradient>
      </defs>
      <circle cx="11" cy="12" r="13" fill="url(#mara-halo)" className="mara-halo" />
      {grid.flatMap((row, y) =>
        row.map((k, x) => (k === "." ? null : (
          <rect key={`${x}-${y}`} x={x} y={y} width="1.02" height="1.02" fill={MARA_PIX[k]} />
        ))),
      )}
    </svg>
  );
}
