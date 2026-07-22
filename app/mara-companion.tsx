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

function MaraLotusSvg({ state }: { state: MaraVisualState }) {
  const sleeping = state === "sleeping";
  const warning = state === "warning";
  const awaiting = state === "awaiting_approval";
  const blooming = state === "blooming";
  const error = state === "error";
  const inspecting = state === "inspecting";
  const petalScale = sleeping ? 0.82 : blooming ? 1.06 : 1;
  const outerPetals = blooming ? 1 : sleeping ? 0.75 : 0.94;
  // Sparkles float around when active — sleeping/error suppress them.
  const showSparkles = !sleeping && !error;

  return (
    <svg
      className={`mara-svg mara-svg-${state.replace("_", "-")}`}
      viewBox="0 0 96 96"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
      focusable="false"
    >
      <defs>
        {/* Green ambient glow — the dominant aura */}
        <radialGradient id="mara-halo-green" cx="50%" cy="50%" r="55%">
          <stop offset="0%" stopColor="#7effb8" stopOpacity="0.55" />
          <stop offset="45%" stopColor="#39ff9c" stopOpacity="0.28" />
          <stop offset="85%" stopColor="#00ff88" stopOpacity="0.05" />
          <stop offset="100%" stopColor="#00ff88" stopOpacity="0" />
        </radialGradient>
        {/* Inner pink accent, kept subtle */}
        <radialGradient id="mara-halo-pink" cx="50%" cy="50%" r="42%">
          <stop offset="0%" stopColor="#ffb3d9" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#ff5aa8" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="mara-petal-outer" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#ffd7ea" />
          <stop offset="55%" stopColor="#ff8ec1" />
          <stop offset="100%" stopColor="#d63384" />
        </linearGradient>
        <linearGradient id="mara-petal-inner" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fff2f8" />
          <stop offset="60%" stopColor="#ffb3d9" />
          <stop offset="100%" stopColor="#ec4899" />
        </linearGradient>
        <radialGradient id="mara-core" cx="50%" cy="38%" r="62%">
          <stop offset="0%" stopColor="#ffffff" />
          <stop offset="55%" stopColor="#ffe1ee" />
          <stop offset="100%" stopColor="#f472b6" />
        </radialGradient>
        <linearGradient id="mara-notebook" x1="0%" y1="0%" x2="0%" y2="100%">
          <stop offset="0%" stopColor="#fffdf2" />
          <stop offset="100%" stopColor="#f5deb3" />
        </linearGradient>
        {/* Green rim light on the core */}
        <radialGradient id="mara-core-rim" cx="50%" cy="90%" r="60%">
          <stop offset="0%" stopColor="#39ff9c" stopOpacity="0.55" />
          <stop offset="100%" stopColor="#39ff9c" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* Layered halos: big green aura + inner pink warmth */}
      <circle cx="48" cy="48" r="46" fill="url(#mara-halo-green)" className="mara-halo-ring mara-halo-green" />
      <circle cx="48" cy="48" r="30" fill="url(#mara-halo-pink)" className="mara-halo-ring mara-halo-pink" />

      {(inspecting || awaiting) && (
        <g className="mara-orbit" aria-hidden="true">
          <circle cx="48" cy="8" r="1.4" className="mara-orbit-dot" fill="#39ff9c" />
          <circle cx="88" cy="48" r="1.2" className="mara-orbit-dot" fill="#39ff9c" />
          <circle cx="48" cy="88" r="1.4" className="mara-orbit-dot" fill="#39ff9c" />
          <circle cx="8" cy="48" r="1.2" className="mara-orbit-dot" fill="#39ff9c" />
        </g>
      )}

      {/* Outer petals — 6 clean symmetric petals */}
      <g
        className="mara-outer-petals"
        transform={`translate(48 44) scale(${petalScale}) translate(-48 -44)`}
        style={{ opacity: outerPetals }}
      >
        {[0, 60, 120, 180, 240, 300].map(angle => (
          <path
            key={angle}
            d="M48 12 C 42 18 40 26 42 34 C 44 38 46 40 48 40 C 50 40 52 38 54 34 C 56 26 54 18 48 12 Z"
            fill="url(#mara-petal-outer)"
            stroke="#a8215e"
            strokeWidth="0.6"
            transform={`rotate(${angle} 48 44)`}
            className="mara-petal-outer-shape"
          />
        ))}
      </g>

      {/* Inner petals — smaller, offset by 30° */}
      <g
        className="mara-inner-petals"
        transform={`translate(48 44) scale(${petalScale}) translate(-48 -44)`}
      >
        {[30, 90, 150, 210, 270, 330].map(angle => (
          <path
            key={angle}
            d="M48 22 C 44 26 43 32 44 38 C 46 41 47 42 48 42 C 49 42 50 41 52 38 C 53 32 52 26 48 22 Z"
            fill="url(#mara-petal-inner)"
            stroke="#c73f83"
            strokeWidth="0.5"
            transform={`rotate(${angle} 48 44)`}
            className="mara-petal-inner-shape"
          />
        ))}
      </g>

      {/* Face core — larger, rounder, chibi proportions */}
      <circle cx="48" cy="44" r="16.5" fill="url(#mara-core)" className="mara-core" stroke="#e91e88" strokeWidth="0.8" />
      {/* Green rim light on the underside */}
      <circle cx="48" cy="44" r="16.5" fill="url(#mara-core-rim)" className="mara-core-rim" />

      {/* Cheeks — bigger, blush-pink */}
      {!sleeping && !error && <g className="mara-cheeks" aria-hidden="true">
        <ellipse cx="36.5" cy="50" rx="3" ry="1.7" fill="#ff8ab8" opacity="0.75" />
        <ellipse cx="59.5" cy="50" rx="3" ry="1.7" fill="#ff8ab8" opacity="0.75" />
      </g>}

      {/* Square nerd glasses — cleaner + slightly bigger */}
      <g
        className={`mara-glasses ${sleeping || error ? "mara-glasses-tilted" : ""}`}
        transform={awaiting || warning ? "rotate(-4 48 43)" : error ? "rotate(6 48 43)" : undefined}
      >
        {/* Bridge */}
        <path d="M45 43.5h6" stroke="#0a0d0a" strokeWidth="1.8" strokeLinecap="round" />
        {/* Temples */}
        <path d="M34 43.5h-2.5" stroke="#0a0d0a" strokeWidth="1.5" strokeLinecap="round" />
        <path d="M62 43.5h2.5" stroke="#0a0d0a" strokeWidth="1.5" strokeLinecap="round" />
        {/* Left square lens */}
        <rect x="34" y="38.5" width="11" height="10" rx="0.8"
          fill="rgba(255, 255, 255, 0.42)"
          stroke="#0a0d0a" strokeWidth="1.9"
          strokeLinejoin="miter" />
        {/* Right square lens */}
        <rect x="51" y="38.5" width="11" height="10" rx="0.8"
          fill="rgba(255, 255, 255, 0.42)"
          stroke="#0a0d0a" strokeWidth="1.9"
          strokeLinejoin="miter" />
        {/* Lens shine — diagonal streaks */}
        <path d="M35.4 40.2l3.6 3.6" stroke="#ffffff" strokeWidth="1.1" strokeLinecap="round" opacity="0.85" />
        <path d="M52.4 40.2l3.6 3.6" stroke="#ffffff" strokeWidth="1.1" strokeLinecap="round" opacity="0.85" />
      </g>

      {/* Eyes behind lenses — bigger sparkles */}
      {sleeping ? (
        <g className="mara-eyes-closed">
          <path d="M36.5 44c1.6 1.2 4.8 1.2 6.5 0" stroke="#0a0d0a" strokeWidth="1.3" strokeLinecap="round" fill="none" />
          <path d="M53 44c1.6 1.2 4.8 1.2 6.5 0" stroke="#0a0d0a" strokeWidth="1.3" strokeLinecap="round" fill="none" />
        </g>
      ) : (
        <g className="mara-eyes">
          <circle cx="39.5" cy={warning || awaiting ? "43" : "43.5"} r="1.9" fill="#0a0d0a" />
          <circle cx="56.5" cy={warning || awaiting ? "43" : "43.5"} r="1.9" fill="#0a0d0a" />
          {/* Big highlight + micro highlight */}
          <circle cx="40.2" cy="42.9" r="0.75" fill="#ffffff" />
          <circle cx="57.2" cy="42.9" r="0.75" fill="#ffffff" />
          <circle cx="38.9" cy="44.1" r="0.35" fill="#ffffff" opacity="0.7" />
          <circle cx="55.9" cy="44.1" r="0.35" fill="#ffffff" opacity="0.7" />
        </g>
      )}

      {/* Smile */}
      {!error && !sleeping && (
        <path
          d={awaiting || warning
            ? "M43.5 53.5c2 1 7 1 9 0"
            : blooming
              ? "M41.5 53c2.5 2.5 10 2.5 12.5 0"
              : "M42.5 53.5c2 1.6 8 1.6 10 0"}
          stroke="#a8215e" strokeWidth="1.5" strokeLinecap="round" fill="none"
        />
      )}
      {error && <path d="M42.5 55.5c2-1.5 8-1.5 10 0" stroke="#a8215e" strokeWidth="1.5" strokeLinecap="round" fill="none" />}

      {/* Arms — soft pink noodle arms cradling the notebook */}
      <g className="mara-arms" aria-hidden="true">
        <path d="M32 60 C 33 66 38 70 44 68"
          stroke="#e91e88" strokeWidth="3.4" strokeLinecap="round" fill="none" opacity="0.95" />
        <path d="M64 60 C 63 66 58 70 52 68"
          stroke="#e91e88" strokeWidth="3.4" strokeLinecap="round" fill="none" opacity="0.95" />
      </g>

      {/* Notebook — floating in front of chest with a green sticky tab */}
      <g className="mara-notebook" aria-hidden="true">
        {/* Notebook back cover for depth */}
        <rect x="32.5" y="64" width="31" height="20.5" rx="2"
          fill="#e0c080" stroke="#0a0d0a" strokeWidth="1.2" opacity="0.6" />
        {/* Notebook front */}
        <rect x="32" y="62.5" width="31" height="20.5" rx="2"
          fill="url(#mara-notebook)" stroke="#0a0d0a" strokeWidth="1.5" />
        {/* Green sticky tab — mint accent */}
        <rect x="55" y="60" width="6" height="4" rx="0.5"
          fill="#39ff9c" stroke="#0a5a2f" strokeWidth="0.6" />
        {/* Spiral binding rings */}
        <g fill="none" stroke="#0a0d0a" strokeWidth="0.9">
          <circle cx="35.5" cy="63" r="1.1" />
          <circle cx="40" cy="63" r="1.1" />
          <circle cx="44.5" cy="63" r="1.1" />
          <circle cx="49" cy="63" r="1.1" />
          <circle cx="53.5" cy="63" r="1.1" />
        </g>
        {/* Ruled lines */}
        <g stroke="#a67328" strokeWidth="0.7" strokeLinecap="round" opacity="0.7">
          <path d="M35 70.5h25" />
          <path d="M35 74.5h25" />
          <path d="M35 78.5h18" />
        </g>
        {/* Pencil tucked under the notebook */}
        <g className="mara-pencil">
          <rect x="60" y="76" width="10" height="2.4" rx="0.4" fill="#ffcf40" stroke="#0a0d0a" strokeWidth="0.6" transform="rotate(-14 65 77)" />
          <path d="M70.5 76.2l2.2 1v0.6z" fill="#333" transform="rotate(-14 65 77)" />
        </g>
      </g>

      {/* Sparkles — subtle green + pink motes that gently float */}
      {showSparkles && (
        <g className="mara-sparkles" aria-hidden="true">
          <circle cx="18" cy="26" r="1.1" fill="#39ff9c" opacity="0.85" className="mara-sparkle mara-sparkle-1" />
          <circle cx="78" cy="22" r="0.9" fill="#7effb8" opacity="0.75" className="mara-sparkle mara-sparkle-2" />
          <circle cx="82" cy="66" r="1.2" fill="#ffb3d9" opacity="0.7" className="mara-sparkle mara-sparkle-3" />
          <circle cx="14" cy="58" r="0.8" fill="#39ff9c" opacity="0.8" className="mara-sparkle mara-sparkle-4" />
          <path d="M76 40l1.2 -1.2M76 40l-1.2 1.2M76 40l1.2 1.2M76 40l-1.2 -1.2"
            stroke="#39ff9c" strokeWidth="0.7" strokeLinecap="round" opacity="0.8" className="mara-sparkle mara-sparkle-5" />
        </g>
      )}

      <rect
        x="4" y="4" width="88" height="88" rx="44"
        fill="none"
        strokeWidth="1.6"
        className={`mara-status-ring mara-status-ring-${state.replace("_", "-")}`}
      />
    </svg>
  );
}
