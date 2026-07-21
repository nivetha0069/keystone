"use client";

// Pointer + keyboard draggable mascot hook.
//
// Contract:
//   - Drag begins after DRAG_THRESHOLD_PX of movement — a plain click still
//     opens/closes the bubble.
//   - Position is clamped to the viewport on every resize/orientation change.
//   - Desktop and mobile positions persist separately in localStorage so a
//     narrow layout does not overwrite the wide-layout position.
//   - Keyboard arrow keys move the mascot by KEY_STEP_PX.
//   - Consumers get: an inline `style` (position:fixed), pointerdown handler,
//     keydown handler, and `resetPosition()` to revert to the default anchor.

import { useCallback, useEffect, useRef, useState } from "react";

const DESKTOP_KEY = "keystone.mara.pos.desktop";
const MOBILE_KEY = "keystone.mara.pos.mobile";
const DRAG_THRESHOLD_PX = 6;
const KEY_STEP_PX = 24;
const MOBILE_BREAKPOINT_PX = 640;
const MASCOT_SIZE_DESKTOP = 92;
const MASCOT_SIZE_MOBILE = 64;
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
};

/**
 * Read a persisted position, snapped to inside viewport. Returns null if none
 * is stored or persistence is blocked.
 */
export function readStoredPosition(isMobile: boolean, viewport: { width: number; height: number }): MascotPosition | null {
  try {
    if (typeof window === "undefined") return null;
    const raw = window.localStorage.getItem(isMobile ? MOBILE_KEY : DESKTOP_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as MascotPosition;
    if (typeof parsed?.x !== "number" || typeof parsed?.y !== "number") return null;
    return clampPosition(parsed, isMobile, viewport);
  } catch { return null; }
}

export function clampPosition(pos: MascotPosition, isMobile: boolean, viewport: { width: number; height: number }): MascotPosition {
  const size = isMobile ? MASCOT_SIZE_MOBILE : MASCOT_SIZE_DESKTOP;
  const maxX = Math.max(MARGIN_PX, viewport.width - size - MARGIN_PX);
  const maxY = Math.max(MARGIN_PX, viewport.height - size - MARGIN_PX);
  return {
    x: Math.min(Math.max(MARGIN_PX, pos.x), maxX),
    y: Math.min(Math.max(MARGIN_PX, pos.y), maxY),
  };
}

export function defaultPosition(isMobile: boolean, viewport: { width: number; height: number }): MascotPosition {
  const size = isMobile ? MASCOT_SIZE_MOBILE : MASCOT_SIZE_DESKTOP;
  return {
    x: Math.max(MARGIN_PX, viewport.width - size - (isMobile ? 12 : 22)),
    y: Math.max(MARGIN_PX, viewport.height - size - (isMobile ? 88 : 22)),
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
    return readStoredPosition(mobile, vp) ?? defaultPosition(mobile, vp);
  });
  const [wasDragged, setWasDragged] = useState(false);
  const dragStateRef = useRef<{ startX: number; startY: number; originX: number; originY: number; moved: boolean } | null>(null);

  // Track viewport + orientation.
  useEffect(() => {
    const onResize = () => {
      setViewport(readViewport());
      setIsMobile(readIsMobile());
    };
    window.addEventListener("resize", onResize);
    window.addEventListener("orientationchange", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      window.removeEventListener("orientationchange", onResize);
    };
  }, []);

  // Re-clamp when viewport changes; also switch stored bucket when crossing
  // the mobile breakpoint. Adjust during render — cheaper than an extra
  // render caused by a setState-in-effect.
  const [lastViewportKey, setLastViewportKey] = useState(`${viewport.width}x${viewport.height}:${isMobile ? "m" : "d"}`);
  const currentViewportKey = `${viewport.width}x${viewport.height}:${isMobile ? "m" : "d"}`;
  if (currentViewportKey !== lastViewportKey) {
    setLastViewportKey(currentViewportKey);
    const stored = readStoredPosition(isMobile, viewport);
    setPosition(current => clampPosition(stored ?? current, isMobile, viewport));
  }

  const persist = useCallback((next: MascotPosition, mobile: boolean) => {
    try {
      if (typeof window === "undefined") return;
      window.localStorage.setItem(mobile ? MOBILE_KEY : DESKTOP_KEY, JSON.stringify(next));
    } catch { /* ignore */ }
  }, []);

  const onPointerDown = useCallback((event: React.PointerEvent<HTMLElement>) => {
    // Ignore drag intent when the pointer starts on an interactive descendant
    // inside the bubble (buttons, links). Only the mascot handle triggers a drag.
    if (event.button !== 0 && event.pointerType === "mouse") return;
    const target = event.target as HTMLElement;
    if (target.closest("[data-mara-no-drag]")) return;
    dragStateRef.current = {
      startX: event.clientX,
      startY: event.clientY,
      originX: position.x,
      originY: position.y,
      moved: false,
    };
    setWasDragged(false);
    // Capture the pointer so we keep receiving move/up events even if the
    // pointer leaves the mascot.
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    const move = (ev: PointerEvent) => {
      const state = dragStateRef.current;
      if (!state) return;
      const dx = ev.clientX - state.startX;
      const dy = ev.clientY - state.startY;
      if (!state.moved && Math.hypot(dx, dy) < DRAG_THRESHOLD_PX) return;
      state.moved = true;
      const next = clampPosition({ x: state.originX + dx, y: state.originY + dy }, isMobile, readViewport());
      setPosition(next);
    };
    const up = (ev: PointerEvent) => {
      const state = dragStateRef.current;
      dragStateRef.current = null;
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      window.removeEventListener("pointercancel", up);
      if (!state) return;
      if (state.moved) {
        setWasDragged(true);
        const finalPos = clampPosition({ x: state.originX + (ev.clientX - state.startX), y: state.originY + (ev.clientY - state.startY) }, isMobile, readViewport());
        persist(finalPos, isMobile);
        // Reset the "was dragged" flag on the next tick so the subsequent
        // click event knows it followed a drag and can be suppressed.
        window.setTimeout(() => setWasDragged(false), 250);
      }
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    window.addEventListener("pointercancel", up);
  }, [position.x, position.y, isMobile, persist]);

  const onKeyDown = useCallback((event: React.KeyboardEvent<HTMLElement>) => {
    if (!["ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight"].includes(event.key)) return;
    event.preventDefault();
    setPosition(current => {
      const dx = event.key === "ArrowLeft" ? -KEY_STEP_PX : event.key === "ArrowRight" ? KEY_STEP_PX : 0;
      const dy = event.key === "ArrowUp" ? -KEY_STEP_PX : event.key === "ArrowDown" ? KEY_STEP_PX : 0;
      const next = clampPosition({ x: current.x + dx, y: current.y + dy }, isMobile, readViewport());
      persist(next, isMobile);
      return next;
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

  const style: React.CSSProperties = {
    position: "fixed",
    left: position.x,
    top: position.y,
    right: "auto",
    bottom: "auto",
    touchAction: "none",
  };

  return { containerRef, style, onPointerDown, onKeyDown, resetPosition, wasDragged, isMobile };
}
