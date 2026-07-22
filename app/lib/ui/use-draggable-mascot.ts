"use client";

// Pointer + keyboard draggable mascot hook.
//
// Contract:
//   - Drag begins only after DRAG_THRESHOLD_PX of movement. Otherwise the
//     press-and-release is a plain click that the consumer routes to
//     open/close.
//   - Position is validated on every read: NaN, non-finite, negative, or
//     out-of-viewport coordinates are rejected and replaced with the default
//     bottom-right anchor.
//   - Pointer capture is always released on pointerup/pointercancel/blur so
//     a lost pointer never strands the mascot.
//   - Desktop and mobile positions persist under separate keys so a narrow
//     viewport does not overwrite the wide-viewport placement.
//   - Arrow keys nudge by KEY_STEP_PX; reset() reverts to the default anchor.

import { useCallback, useEffect, useRef, useState } from "react";

const DESKTOP_KEY = "keystone.mara.pos.desktop";
const MOBILE_KEY = "keystone.mara.pos.mobile";
const DRAG_THRESHOLD_PX = 6;
const KEY_STEP_PX = 24;
const MOBILE_BREAKPOINT_PX = 640;
const MASCOT_SIZE_DESKTOP = 132;
const MASCOT_SIZE_MOBILE = 96;
const MARGIN_PX = 16;

export type MascotPosition = { x: number; y: number };

export type UseDraggableMascotResult = {
  containerRef: React.MutableRefObject<HTMLDivElement | null>;
  style: React.CSSProperties;
  onPointerDown: (event: React.PointerEvent<HTMLElement>) => void;
  onKeyDown: (event: React.KeyboardEvent<HTMLElement>) => void;
  resetPosition: () => void;
  wasDragged: boolean;
  isMobile: boolean;
  debug: {
    x: number;
    y: number;
    viewportWidth: number;
    viewportHeight: number;
    dragging: boolean;
    mounted: boolean;
    zIndex: number;
  };
};

/** Rejects NaN, Infinity, negative, or non-numeric values. */
function isValidCoord(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Rejects any position that is not entirely numeric AND inside the viewport. */
function isPositionValid(pos: MascotPosition | null | undefined, isMobile: boolean, viewport: { width: number; height: number }): pos is MascotPosition {
  if (!pos || typeof pos !== "object") return false;
  if (!isValidCoord(pos.x) || !isValidCoord(pos.y)) return false;
  const size = isMobile ? MASCOT_SIZE_MOBILE : MASCOT_SIZE_DESKTOP;
  if (pos.x + size > viewport.width + 1) return false;
  if (pos.y + size > viewport.height + 1) return false;
  return true;
}

export function readStoredPosition(isMobile: boolean, viewport: { width: number; height: number }): MascotPosition | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(isMobile ? MOBILE_KEY : DESKTOP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MascotPosition;
    if (!isValidCoord(parsed?.x) || !isValidCoord(parsed?.y)) return null;
    const clamped = clampPosition(parsed, isMobile, viewport);
    return isPositionValid(clamped, isMobile, viewport) ? clamped : null;
  } catch { return null; }
}

export function clampPosition(pos: MascotPosition, isMobile: boolean, viewport: { width: number; height: number }): MascotPosition {
  // Any non-finite input collapses to the default anchor — never bleed
  // NaN/Infinity into inline styles.
  if (!isValidCoord(pos?.x) || !isValidCoord(pos?.y)) return defaultPosition(isMobile, viewport);
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : MASCOT_SIZE_DESKTOP + MARGIN_PX * 2;
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : MASCOT_SIZE_DESKTOP + MARGIN_PX * 2;
  const size = isMobile ? MASCOT_SIZE_MOBILE : MASCOT_SIZE_DESKTOP;
  const maxX = Math.max(MARGIN_PX, width - size - MARGIN_PX);
  const maxY = Math.max(MARGIN_PX, height - size - MARGIN_PX);
  return {
    x: Math.min(Math.max(MARGIN_PX, pos.x), maxX),
    y: Math.min(Math.max(MARGIN_PX, pos.y), maxY),
  };
}

export function defaultPosition(isMobile: boolean, viewport: { width: number; height: number }): MascotPosition {
  const width = Number.isFinite(viewport.width) && viewport.width > 0 ? viewport.width : 1440;
  const height = Number.isFinite(viewport.height) && viewport.height > 0 ? viewport.height : 900;
  const size = isMobile ? MASCOT_SIZE_MOBILE : MASCOT_SIZE_DESKTOP;
  return {
    x: Math.max(MARGIN_PX, width - size - (isMobile ? 12 : 22)),
    y: Math.max(MARGIN_PX, height - size - (isMobile ? 88 : 22)),
  };
}

function readViewport(): { width: number; height: number } {
  if (typeof window === "undefined") return { width: 1440, height: 900 };
  return { width: window.innerWidth, height: window.innerHeight };
}

function readIsMobile(): boolean {
  if (typeof window === "undefined") return false;
  return window.matchMedia(`(max-width: ${MOBILE_BREAKPOINT_PX}px)`).matches;
}

export function useDraggableMascot(): UseDraggableMascotResult {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [viewport, setViewport] = useState(() => readViewport());
  const [isMobile, setIsMobile] = useState(() => readIsMobile());
  const [position, setPosition] = useState<MascotPosition>(() => {
    const vp = readViewport();
    const mobile = readIsMobile();
    const stored = readStoredPosition(mobile, vp);
    const initial = stored ?? defaultPosition(mobile, vp);
    // Final safety: if for any reason initial is invalid, use default.
    return isPositionValid(initial, mobile, vp) ? initial : defaultPosition(mobile, vp);
  });
  const [wasDragged, setWasDragged] = useState(false);
  const [dragging, setDragging] = useState(false);
  const dragStateRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean; pointerId: number; captureEl: HTMLElement | null } | null>(null);
  const moveListenerRef = useRef<((ev: PointerEvent) => void) | null>(null);
  const upListenerRef = useRef<((ev: PointerEvent) => void) | null>(null);

  const cleanupDrag = useCallback(() => {
    const state = dragStateRef.current;
    if (state?.captureEl && typeof state.captureEl.releasePointerCapture === "function") {
      try { state.captureEl.releasePointerCapture(state.pointerId); } catch { /* ignore */ }
    }
    dragStateRef.current = null;
    if (moveListenerRef.current) {
      window.removeEventListener("pointermove", moveListenerRef.current);
      moveListenerRef.current = null;
    }
    if (upListenerRef.current) {
      window.removeEventListener("pointerup", upListenerRef.current);
      window.removeEventListener("pointercancel", upListenerRef.current);
      upListenerRef.current = null;
    }
    setDragging(false);
  }, []);

  // Track viewport + orientation.
  useEffect(() => {
    const onResize = () => {
      setViewport(readViewport());
      setIsMobile(readIsMobile());
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    // Blur / hidden events cancel any in-flight drag so the pointer never
    // strands the mascot when the user tabs away or the phone locks.
    const onBlur = () => cleanupDrag();
    const onVisibility = () => { if (document.hidden) cleanupDrag(); };
    window.addEventListener("blur", onBlur);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
      window.removeEventListener("blur", onBlur);
      document.removeEventListener("visibilitychange", onVisibility);
      cleanupDrag();
    };
  }, [cleanupDrag]);

  // Re-clamp when viewport or mobile bucket changes. Adjust during render so we
  // avoid an extra effect-driven render.
  const [lastViewportKey, setLastViewportKey] = useState(`${viewport.width}x${viewport.height}:${isMobile ? "m" : "d"}`);
  const currentViewportKey = `${viewport.width}x${viewport.height}:${isMobile ? "m" : "d"}`;
  if (currentViewportKey !== lastViewportKey) {
    setLastViewportKey(currentViewportKey);
    const stored = readStoredPosition(isMobile, viewport);
    setPosition(current => {
      const candidate = stored ?? current;
      const clamped = clampPosition(candidate, isMobile, viewport);
      return isPositionValid(clamped, isMobile, viewport) ? clamped : defaultPosition(isMobile, viewport);
    });
  }

  const persist = useCallback((next: MascotPosition, mobile: boolean) => {
    try {
      if (typeof window === "undefined") return;
      if (!isValidCoord(next.x) || !isValidCoord(next.y)) return;
      window.localStorage.setItem(mobile ? MOBILE_KEY : DESKTOP_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-mara-no-drag]")) return;
    const currentTarget = event.currentTarget as HTMLElement;
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
      pointerId: event.pointerId,
      captureEl: currentTarget,
    };
    setWasDragged(false);
    try { currentTarget.setPointerCapture(event.pointerId); } catch { /* ignore */ }
    const move = (ev: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      const dx = ev.clientX - state.startX;
      const dy = ev.clientY - state.startY;
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      if (!state.moved) setDragging(true);
      state.moved = true;
      const candidate = { x: state.originX + dx, y: state.originY + dy };
      const next = clampPosition(candidate, isMobile, readViewport());
      // Guard: never write NaN into position state.
      if (isValidCoord(next.x) && isValidCoord(next.y)) setPosition(next);
    };
    const up = (ev: PointerEvent) => {
      const state = dragStateRef.current;
      if (state) {
        // Persist only when a drag actually happened.
        if (state.moved) {
          const finalPos = clampPosition({ x: state.originX + (ev.clientX - state.startX), y: state.originY + (ev.clientY - state.startY) }, isMobile, readViewport());
          if (isValidCoord(finalPos.x) && isValidCoord(finalPos.y)) {
            persist(finalPos, isMobile);
            setPosition(finalPos);
          }
          setWasDragged(true);
          window.setTimeout(() => setWasDragged(false), 250);
        }
      }
      cleanupDrag();
    };
    moveListenerRef.current = move;
    upListenerRef.current = up;
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [position.x, position.y, isMobile, persist, cleanupDrag]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    setPosition(current => {
      const dx = event.key === "ArrowLeft" ? -KEY_STEP_PX : event.key === "ArrowRight" ? KEY_STEP_PX : 0;
      const dy = event.key === "ArrowUp" ? -KEY_STEP_PX : event.key === "ArrowDown" ? KEY_STEP_PX : 0;
      const next = clampPosition({ x: current.x + dx, y: current.y + dy }, isMobile, readViewport());
      const safe = isValidCoord(next.x) && isValidCoord(next.y) ? next : defaultPosition(isMobile, readViewport());
      persist(safe, isMobile);
      return safe;
    });
  }, [isMobile, persist]);

  const resetPosition = useCallback(() => {
    const vp = readViewport();
    const mobile = readIsMobile();
    const next = defaultPosition(mobile, vp);
    setPosition(next);
    try {
      if (typeof window !== "undefined") {
        window.localStorage.removeItem(mobile ? MOBILE_KEY : DESKTOP_KEY);
      }
    } catch { /* ignore */ }
  }, []);

  // Final render guard: if the state ever holds an invalid position (should be
  // impossible after the setters above), collapse to the default anchor.
  const safePosition = isPositionValid(position, isMobile, viewport)
    ? position
    : defaultPosition(isMobile, viewport);

  const style: React.CSSProperties = {
    position: "fixed",
    left: safePosition.x,
    top: safePosition.y,
    right: "auto",
    bottom: "auto",
    touchAction: "none",
    zIndex: 9000,
    pointerEvents: "auto",
    // Break out of any stacking / containment context set by ancestor panels.
    contain: "none" as unknown as React.CSSProperties["contain"],
  };

  return {
    containerRef,
    style,
    onPointerDown,
    onKeyDown,
    resetPosition,
    wasDragged,
    isMobile,
    debug: {
      x: safePosition.x,
      y: safePosition.y,
      viewportWidth: viewport.width,
      viewportHeight: viewport.height,
      dragging,
      mounted: true,
      zIndex: 9000,
    },
  };
}
