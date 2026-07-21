"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ConfigurationItem, HealthData, HealthFix, TimelineEvent } from "./cmdb-data";
import {
  buildMaraMessage,
  deriveMaraState,
  type MaraFindingLike,
  type MaraReviewLike,
  type MaraSection,
} from "./lib/cmdb/mara-companion-state";
import type {
  MaraActionKey,
  MaraLive,
  MaraLiveState,
  MaraVisualState,
  WorkspaceViewState,
} from "./lib/cmdb/workspace-view-state";
import { useDraggableMascot } from "./lib/ui/use-draggable-mascot";

const MUTE_STORAGE_KEY = "keystone.mara.muted";
const AUTO_COLLAPSE_MS = 12000;

// The bubble opens only when the user clicks Mara. We used to auto-open on
// state transitions (approvals, warnings, completion) but that overflowed on
// small viewports and forced users to hunt for the close control.
const AUTO_OPEN_STATES = new Set<MaraLiveState>();

type ApiState = "connecting" | "live" | "partial" | "demo" | "error";
type AnalysisState = "idle" | "starting" | "started" | "error";

export type MaraCompanionProps = {
  section: MaraSection;
  activeRunId: string;
  activeRunLabel: string;
  runState: string;
  analysisState: AnalysisState;
  apiState: ApiState;
  timeline: TimelineEvent[];
  cis: ConfigurationItem[];
  health: HealthData;
  findings: MaraFindingLike[];
  reviews: MaraReviewLike[];
  queuedFix: HealthFix | null;
  view?: WorkspaceViewState;
  onNavigate: (section: MaraSection) => void;
  onOpenLedger: () => void;
  onOpenApprovals?: () => void;
  onOpenRemediation?: () => void;
  onShowReviewQueue: () => void;
};

type MaraAction = { key: MaraActionKey; label: string; onSelect: () => void };

export function MaraCompanion(props: MaraCompanionProps) {
  const {
    section, activeRunId, activeRunLabel, runState, analysisState, apiState,
    timeline, cis, health, findings, reviews, queuedFix, view,
    onNavigate, onOpenLedger, onOpenApprovals, onOpenRemediation, onShowReviewQueue,
  } = props;

  const topFixTitle = queuedFix?.title ?? health.fixes[0]?.title;

  // Fallback derivation for surfaces that don't hand us a workspace view yet.
  // The dashboard always passes `view`, so this is defensive only.
  const fallbackDerivation = useMemo(() => deriveMaraState({
    section, activeRunId, runState, analysisState, apiState,
    timeline, cis, health, findings, reviews, topFixTitle,
  }), [
    section, activeRunId, runState, analysisState, apiState,
    timeline, cis, health, findings, reviews, topFixTitle,
  ]);
  const fallbackMessage = useMemo(() => buildMaraMessage({
    section, activeRunId, runState, analysisState, apiState,
    timeline, cis, health, findings, reviews, topFixTitle,
  }, fallbackDerivation), [
    fallbackDerivation, section, activeRunId, runState, analysisState, apiState,
    timeline, cis, health, findings, reviews, topFixTitle,
  ]);

  const live: MaraLive = view?.mara ?? {
    state: fallbackDerivation.state === "blooming" ? "completed" : fallbackDerivation.state as MaraLiveState,
    visualState: fallbackDerivation.state,
    headline: fallbackHeadline(fallbackDerivation.state),
    message: fallbackMessage.primary,
    secondary: fallbackMessage.secondary,
    actions: ["watch_activity"],
  };

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
        case "watch_agents":
        case "watch_activity":
          return { key, label: "Watch activity", onSelect: () => onNavigate("live") };
        case "open_team": return { key, label: "Team", onSelect: () => onNavigate("hr") };
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
  // Meaningful transition key: state + latest event id. Polling with the same
  // (state, event) will not re-open the bubble.
  const transitionKey = `${live.state}:${live.latestEventId ?? "0"}`;
  const [lastTransitionKey, setLastTransitionKey] = useState(transitionKey);
  const [openedAt, setOpenedAt] = useState(0);
  const autoCloseTimerRef = useRef<number | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);

  if (transitionKey !== lastTransitionKey) {
    setLastTransitionKey(transitionKey);
    if (!muted && AUTO_OPEN_STATES.has(live.state)) {
      setOpen(true);
      setOpenedAt(value => value + 1);
    }
  }

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

function fallbackHeadline(state: MaraVisualState): string {
  switch (state) {
    case "sleeping": return "Resting";
    case "inspecting": return "Inspecting";
    case "warning": return "Attention needed";
    case "awaiting_approval": return "Awaiting decision";
    case "blooming": return "Verified";
    case "error": return "Interrupted";
  }
}

function MaraLotusSvg({ state }: { state: MaraVisualState }) {
  const sleeping = state === "sleeping";
  const warning = state === "warning";
  const awaiting = state === "awaiting_approval";
  const blooming = state === "blooming";
  const error = state === "error";
  const inspecting = state === "inspecting";
  const petalScale = sleeping ? 0.78 : blooming ? 1.05 : 1;
  const outerPetals = blooming ? 1 : sleeping ? 0.7 : 0.9;

  return (
    <svg
      className={`mara-svg mara-svg-${state.replace("_", "-")}`}
      viewBox="0 0 96 96"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        <radialGradient id="mara-halo" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#ffb3d9" stopOpacity="0.35" />
          <stop offset="60%" stopColor="#ff5aa8" stopOpacity="0.08" />
          <stop offset="100%" stopColor="#ff5aa8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mara-petal-outer" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffc4de" />
          <stop offset="100%" stopColor="#d64084" />
        </linearGradient>
        <linearGradient id="mara-petal-inner" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffe1ee" />
          <stop offset="100%" stopColor="#f472b6" />
        </linearGradient>
        <radialGradient id="mara-core" cx="50%" cy="42%" r="58%">
          <stop offset="0%" stopColor="#fff2f7" />
          <stop offset="60%" stopColor="#ffd3e5" />
          <stop offset="100%" stopColor="#f472b6" />
        </radialGradient>
        <linearGradient id="mara-notebook" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fff8e5" />
          <stop offset="100%" stopColor="#f7d774" />
        </linearGradient>
      </defs>

      <circle cx="48" cy="48" r="46" fill="url(#mara-halo)" className="mara-halo-ring" />

      {(inspecting || awaiting) && (
        <g className="mara-orbit" aria-hidden="true">
          <circle cx="48" cy="10" r="1.6" className="mara-orbit-dot" />
          <circle cx="86" cy="48" r="1.4" className="mara-orbit-dot" />
          <circle cx="48" cy="86" r="1.6" className="mara-orbit-dot" />
          <circle cx="10" cy="48" r="1.4" className="mara-orbit-dot" />
        </g>
      )}

      <g
        className="mara-outer-petals"
        transform={`translate(48 46) scale(${petalScale}) translate(-48 -46)`}
        style={{ opacity: outerPetals }}
      >
        {[0, 60, 120, 180, 240, 300].map(angle => (
          <ellipse
            key={angle}
            cx="48"
            cy="18"
            rx="9"
            ry="21"
            fill="url(#mara-petal-outer)"
            stroke="#a8215e"
            strokeWidth="0.7"
            transform={`rotate(${angle} 48 46)`}
            className="mara-petal-outer-shape"
          />
        ))}
      </g>

      <g
        className="mara-inner-petals"
        transform={`translate(48 46) scale(${petalScale}) translate(-48 -46)`}
      >
        {[30, 90, 150, 210, 270, 330].map(angle => (
          <ellipse
            key={angle}
            cx="48"
            cy="27"
            rx="6.5"
            ry="15"
            fill="url(#mara-petal-inner)"
            stroke="#c73f83"
            strokeWidth="0.5"
            transform={`rotate(${angle} 48 46)`}
            className="mara-petal-inner-shape"
          />
        ))}
      </g>

      {/* Face core */}
      <circle cx="48" cy="46" r="15" fill="url(#mara-core)" className="mara-core" stroke="#c73f83" strokeWidth="0.7" />

      {/* Cheeks */}
      {!sleeping && !error && <g className="mara-cheeks" aria-hidden="true">
        <ellipse cx="37" cy="52" rx="2.2" ry="1.3" fill="#ff8ab8" opacity="0.7" />
        <ellipse cx="59" cy="52" rx="2.2" ry="1.3" fill="#ff8ab8" opacity="0.7" />
      </g>}

      {/* Square nerd glasses */}
      <g
        className={`mara-glasses ${sleeping || error ? "mara-glasses-tilted" : ""}`}
        transform={awaiting || warning ? "rotate(-4 48 45)" : error ? "rotate(6 48 45)" : undefined}
      >
        {/* Bridge */}
        <path d="M45.5 45.5h5" stroke="#11150e" strokeWidth="1.6" strokeLinecap="round" />
        {/* Temples */}
        <path d="M35 45.5h-2.5" stroke="#11150e" strokeWidth="1.4" strokeLinecap="round" />
        <path d="M61 45.5h2.5" stroke="#11150e" strokeWidth="1.4" strokeLinecap="round" />
        {/* Left square lens */}
        <rect x="35" y="41" width="10.5" height="9" rx="0.6"
          fill="rgba(255, 255, 255, 0.35)"
          stroke="#11150e" strokeWidth="1.7"
          strokeLinejoin="miter" />
        {/* Right square lens */}
        <rect x="50.5" y="41" width="10.5" height="9" rx="0.6"
          fill="rgba(255, 255, 255, 0.35)"
          stroke="#11150e" strokeWidth="1.7"
          strokeLinejoin="miter" />
        {/* Lens shine */}
        <path d="M36.3 42.4l3.2 3.2" stroke="#ffffff" strokeWidth="0.9" strokeLinecap="round" opacity="0.8" />
        <path d="M51.8 42.4l3.2 3.2" stroke="#ffffff" strokeWidth="0.9" strokeLinecap="round" opacity="0.8" />
      </g>

      {/* Eyes behind lenses */}
      {sleeping ? (
        <g className="mara-eyes-closed">
          <path d="M37.5 46c1.5 1 4.5 1 6 0" stroke="#11150e" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M52.5 46c1.5 1 4.5 1 6 0" stroke="#11150e" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        </g>
      ) : (
        <g className="mara-eyes">
          <circle cx="40.3" cy={warning || awaiting ? "45" : "45.5"} r="1.5" fill="#11150e" />
          <circle cx="55.7" cy={warning || awaiting ? "45" : "45.5"} r="1.5" fill="#11150e" />
          <circle cx="40.8" cy="45" r="0.55" fill="#ffffff" />
          <circle cx="56.2" cy="45" r="0.55" fill="#ffffff" />
        </g>
      )}

      {/* Smile */}
      {!error && !sleeping && (
        <path
          d={awaiting || warning
            ? "M44 55.5c1.5 0.8 6.5 0.8 8 0"
            : blooming
              ? "M42.5 55c2 2 9 2 11 0"
              : "M43.5 55.2c1.8 1.4 7 1.4 9 0"}
          stroke="#a8215e" strokeWidth="1.3" strokeLinecap="round" fill="none"
        />
      )}
      {error && <path d="M43.5 57c2-1.4 7-1.4 9 0" stroke="#a8215e" strokeWidth="1.3" strokeLinecap="round" fill="none" />}

      {/* Arms holding notebook */}
      <g className="mara-arms" aria-hidden="true">
        <path d="M32 60c3 4 8 6 13 6" stroke="#d64084" strokeWidth="3.2" strokeLinecap="round" fill="none" />
        <path d="M64 60c-3 4-8 6-13 6" stroke="#d64084" strokeWidth="3.2" strokeLinecap="round" fill="none" />
      </g>

      {/* Notebook */}
      <g className="mara-notebook" aria-hidden="true">
        <rect x="33" y="63" width="30" height="20" rx="1.4"
          fill="url(#mara-notebook)" stroke="#11150e" strokeWidth="1.4" />
        {/* Spiral binding */}
        <g stroke="#11150e" strokeWidth="1.1" strokeLinecap="round">
          <path d="M36 62.5v3" />
          <path d="M41 62.5v3" />
          <path d="M46 62.5v3" />
          <path d="M51 62.5v3" />
          <path d="M56 62.5v3" />
          <path d="M60 62.5v3" />
        </g>
        {/* Ruled lines */}
        <g stroke="#c07a1a" strokeWidth="0.7" strokeLinecap="round" opacity="0.75">
          <path d="M36 71h24" />
          <path d="M36 75h24" />
          <path d="M36 79h18" />
        </g>
        {/* Little pencil tip */}
        <path d="M63 73l3 -1.5v3z" fill="#11150e" />
      </g>

      <rect
        x="4" y="4" width="88" height="88" rx="44"
        fill="none"
        strokeWidth="1.6"
        className={`mara-status-ring mara-status-ring-${state.replace("_", "-")}`}
      />
    </svg>
  );
}
