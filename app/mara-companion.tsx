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

// States that should proactively open the bubble when they arrive. Everything
// else stays quietly in the mascot until the user opens it.
const AUTO_OPEN_STATES = new Set<MaraLiveState>([
  "awaiting_review",
  "awaiting_approval",
  "executing",
  "verifying",
  "completed",
  "warning",
  "error",
]);

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
  const outerPetals = blooming ? 0.98 : sleeping ? 0.62 : 0.85;

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
          <stop offset="0%" stopColor="var(--lime)" stopOpacity="0.28" />
          <stop offset="60%" stopColor="var(--lime)" stopOpacity="0.06" />
          <stop offset="100%" stopColor="var(--lime)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mara-petal-outer" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#7fc46b" />
          <stop offset="100%" stopColor="#3d7a44" />
        </linearGradient>
        <linearGradient id="mara-petal-inner" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#c7f34d" />
          <stop offset="100%" stopColor="#59c58b" />
        </linearGradient>
        <radialGradient id="mara-core" cx="50%" cy="45%" r="55%">
          <stop offset="0%" stopColor="#f6ffcf" />
          <stop offset="60%" stopColor="var(--lime)" />
          <stop offset="100%" stopColor="#4d8f36" />
        </radialGradient>
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
        transform={`translate(48 52) scale(${petalScale}) translate(-48 -52)`}
        style={{ opacity: outerPetals }}
      >
        {[0, 60, 120, 180, 240, 300].map(angle => (
          <ellipse
            key={angle}
            cx="48"
            cy="20"
            rx="9"
            ry="20"
            fill="url(#mara-petal-outer)"
            transform={`rotate(${angle} 48 52)`}
            className="mara-petal-outer-shape"
          />
        ))}
      </g>

      <g
        className="mara-inner-petals"
        transform={`translate(48 52) scale(${petalScale}) translate(-48 -52)`}
      >
        {[30, 90, 150, 210, 270, 330].map(angle => (
          <ellipse
            key={angle}
            cx="48"
            cy="30"
            rx="6.5"
            ry="15"
            fill="url(#mara-petal-inner)"
            transform={`rotate(${angle} 48 52)`}
            className="mara-petal-inner-shape"
          />
        ))}
      </g>

      <g className="mara-arms" aria-hidden="true">
        <ellipse cx="18" cy="60" rx="6" ry="3" fill="#4d8f36" transform="rotate(-25 18 60)" />
        <ellipse cx="78" cy="60" rx="6" ry="3" fill="#4d8f36" transform="rotate(25 78 60)" />
      </g>

      <circle cx="48" cy="52" r="14" fill="url(#mara-core)" className="mara-core" />

      <g
        className={`mara-glasses ${sleeping || error ? "mara-glasses-tilted" : ""}`}
        transform={awaiting || warning ? "rotate(-4 48 51)" : error ? "rotate(6 48 51)" : undefined}
      >
        <circle cx="41" cy="51" r="5.4" fill="rgba(10, 12, 11, 0.55)" stroke="#e6eede" strokeWidth="1.2" />
        <circle cx="55" cy="51" r="5.4" fill="rgba(10, 12, 11, 0.55)" stroke="#e6eede" strokeWidth="1.2" />
        <path d="M46.4 51h3.2" stroke="#e6eede" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M35.6 51h-1.4" stroke="#e6eede" strokeWidth="1.2" strokeLinecap="round" />
        <path d="M60.4 51h1.4" stroke="#e6eede" strokeWidth="1.2" strokeLinecap="round" />
      </g>

      {sleeping ? (
        <g className="mara-eyes-closed">
          <path d="M38 51.5c1.5 1 4.5 1 6 0" stroke="#11150e" strokeWidth="1.2" strokeLinecap="round" fill="none" />
          <path d="M52 51.5c1.5 1 4.5 1 6 0" stroke="#11150e" strokeWidth="1.2" strokeLinecap="round" fill="none" />
        </g>
      ) : (
        <g className="mara-eyes">
          <circle cx="41" cy={warning || awaiting ? "50" : "51"} r="1.6" fill="#11150e" />
          <circle cx="55" cy={warning || awaiting ? "50" : "51"} r="1.6" fill="#11150e" />
          <circle cx="41.7" cy="50.3" r="0.55" fill="#f6ffcf" />
          <circle cx="55.7" cy="50.3" r="0.55" fill="#f6ffcf" />
        </g>
      )}

      <circle
        cx="48"
        cy="48"
        r="44"
        fill="none"
        strokeWidth="1.6"
        className={`mara-status-ring mara-status-ring-${state.replace("_", "-")}`}
      />
    </svg>
  );
}
