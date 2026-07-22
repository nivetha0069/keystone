"use client";

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
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

  // Keep the bubble inside the viewport regardless of where the mascot was dragged.
  // The mascot's container is anchored by its own coord; the wider bubble can
  // overflow, so nudge it back into view with a translate.
  const anchorLeft = style.left;
  const anchorTop = style.top;
  const anchorRight = style.right;
  const anchorBottom = style.bottom;
  useLayoutEffect(() => {
    if (!open) return;
    const node = bubbleRef.current;
    if (!node) return;
    const nudge = () => {
      node.style.transform = "";
      const rect = node.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      const MARGIN = 12;
      let dx = 0;
      let dy = 0;
      const overRight = rect.right - (vw - MARGIN);
      const overLeft = MARGIN - rect.left;
      if (overRight > 0) dx = -overRight;
      else if (overLeft > 0) dx = overLeft;
      const overTop = MARGIN - rect.top;
      const overBottom = rect.bottom - (vh - MARGIN);
      if (overTop > 0) dy = overTop;
      else if (overBottom > 0) dy = -overBottom;
      if (dx !== 0 || dy !== 0) node.style.transform = `translate(${dx}px, ${dy}px)`;
    };
    nudge();
    window.addEventListener("resize", nudge);
    return () => { window.removeEventListener("resize", nudge); };
  }, [open, live.message, live.secondary, anchorLeft, anchorTop, anchorRight, anchorBottom]);

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

// Smooth green-lotus Mara. A clean vector lotus in the app's lime/green
// theme (no pixelation), keeping her signature glasses + face. State drives
// the halo tint, eyes, and mouth.
function MaraLotusSvg({ state }: { state: MaraVisualState }) {
  const sleeping = state === "sleeping";
  const error = state === "error";
  const warning = state === "warning" || state === "awaiting_approval";
  const blooming = state === "blooming";
  const halo = error ? "#ff6542"
    : warning ? "#e8b23d"
      : sleeping ? "#59c58b"
        : blooming ? "#7bd8a2"
          : "#c7f34d";

  return (
    <svg
      className={`mara-svg mara-svg-${state.replace("_", "-")}`}
      viewBox="0 0 96 96"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="mara-halo" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor={halo} stopOpacity="0.5" />
          <stop offset="55%" stopColor={halo} stopOpacity="0.2" />
          <stop offset="100%" stopColor={halo} stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mara-petal-outer" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#e6f8b0" />
          <stop offset="55%" stopColor="#a6df5a" />
          <stop offset="100%" stopColor="#4fae7a" />
        </linearGradient>
        <linearGradient id="mara-petal-inner" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#f3fbd2" />
          <stop offset="60%" stopColor="#c7f34d" />
          <stop offset="100%" stopColor="#6ec78d" />
        </linearGradient>
        <radialGradient id="mara-core" cx="50%" cy="40%" r="62%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="55%" stopColor="#f4f9e2" />
          <stop offset="100%" stopColor="#c3e39a" />
        </radialGradient>
      </defs>

      <circle cx="48" cy="48" r="46" fill="url(#mara-halo)" className="mara-halo" />

      {/* Outer petals */}
      <g className="mara-petals-outer">
        {[0, 60, 120, 180, 240, 300].map(a => (
          <path key={a}
            d="M48 14 C 42 20 40 28 42 36 C 44 40 46 42 48 42 C 50 42 52 40 54 36 C 56 28 54 20 48 14 Z"
            fill="url(#mara-petal-outer)" stroke="#3f8b5f" strokeWidth="0.7"
            transform={`rotate(${a} 48 46)`} />
        ))}
      </g>
      {/* Inner petals */}
      <g className="mara-petals-inner">
        {[30, 90, 150, 210, 270, 330].map(a => (
          <path key={a}
            d="M48 24 C 44 28 43 33 44 39 C 46 42 47 43 48 43 C 49 43 50 42 52 39 C 53 33 52 28 48 24 Z"
            fill="url(#mara-petal-inner)" stroke="#5aa878" strokeWidth="0.6"
            transform={`rotate(${a} 48 46)`} />
        ))}
      </g>

      {/* Face core */}
      <circle cx="48" cy="46" r="16" fill="url(#mara-core)" stroke="#5aa878" strokeWidth="0.9" />

      {/* Cheeks */}
      {!sleeping && !error && <g>
        <ellipse cx="37" cy="51" rx="3" ry="1.7" fill="#9ed36a" opacity="0.8" />
        <ellipse cx="59" cy="51" rx="3" ry="1.7" fill="#9ed36a" opacity="0.8" />
      </g>}

      {/* Glasses */}
      <g transform={warning ? "rotate(-3 48 45)" : error ? "rotate(4 48 45)" : undefined}>
        <path d="M45 45.5h6" stroke="#12241a" strokeWidth="1.8" strokeLinecap="round" />
        <path d="M34 45.5h-2.5" stroke="#12241a" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M62 45.5h2.5" stroke="#12241a" strokeWidth="1.4" strokeLinecap="round" />
        <rect x="34" y="40.5" width="11" height="10" rx="2.6" fill="rgba(255,255,255,0.35)" stroke="#12241a" strokeWidth="1.9" />
        <rect x="51" y="40.5" width="11" height="10" rx="2.6" fill="rgba(255,255,255,0.35)" stroke="#12241a" strokeWidth="1.9" />
      </g>

      {/* Eyes */}
      {sleeping ? (
        <g>
          <path d="M36.5 46c1.6 1.2 4.8 1.2 6.5 0" stroke="#12241a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
          <path d="M53 46c1.6 1.2 4.8 1.2 6.5 0" stroke="#12241a" strokeWidth="1.4" fill="none" strokeLinecap="round" />
        </g>
      ) : (
        <g>
          <circle cx="39.5" cy={warning ? "45" : "45.5"} r="2" fill="#12241a" />
          <circle cx="56.5" cy={warning ? "45" : "45.5"} r="2" fill="#12241a" />
          <circle cx="40.3" cy="44.8" r="0.7" fill="#ffffff" />
          <circle cx="57.3" cy="44.8" r="0.7" fill="#ffffff" />
        </g>
      )}

      {/* Mouth */}
      {!sleeping && !error && (
        <path d={blooming ? "M42 55c3 2.6 9 2.6 12 0" : "M43 55.5c2 1.5 8 1.5 10 0"}
          stroke="#2f6b4a" strokeWidth="1.6" fill="none" strokeLinecap="round" />
      )}
      {sleeping && <path d="M44 55.5c2 0.8 6 0.8 8 0" stroke="#2f6b4a" strokeWidth="1.5" fill="none" strokeLinecap="round" />}
      {error && <path d="M43 56.5c2-1.4 8-1.4 10 0" stroke="#2f6b4a" strokeWidth="1.6" fill="none" strokeLinecap="round" />}

      {/* Sparkles */}
      {!sleeping && !error && <g>
        <circle cx="20" cy="30" r="1.1" fill="#c7f34d" opacity="0.8" />
        <circle cx="78" cy="26" r="0.9" fill="#7bd8a2" opacity="0.7" />
      </g>}
    </svg>
  );
}
