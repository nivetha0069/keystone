"use client";

import { useSyncExternalStore } from "react";
import {
  demoModeServerSnapshot,
  isDemoMode,
  setDemoMode,
  subscribeDemoMode,
} from "../lib/cmdb/demo-mode";
import { resetDemoWriteState } from "../lib/cmdb/demo-transport";

/**
 * Subscribes to the module-level demo flag. `useSyncExternalStore` gives the
 * server snapshot (always `false`) during SSR, so hydration cannot mismatch even
 * though the real value lives in localStorage.
 */
export function useDemoMode(): boolean {
  return useSyncExternalStore(subscribeDemoMode, isDemoMode, demoModeServerSnapshot);
}

/**
 * The switch. Deliberately understated — a dot and a four-letter label sitting
 * next to the instance pill. It should be findable, not attention-grabbing:
 * the point of demo mode is to keep presenting, not to announce itself.
 */
export function DemoToggle() {
  const demoMode = useDemoMode();
  return (
    <button
      type="button"
      className={demoMode ? "demo-toggle active" : "demo-toggle"}
      aria-pressed={demoMode}
      title={demoMode
        ? "Demo mode is on — every panel is showing simulated data and no request reaches ServiceNow. Click to return to live."
        : "Show simulated data instead of calling ServiceNow. Useful when the instance is unreachable."}
      onClick={() => {
        // Discard simulated write evidence on the way out so it can never be
        // mistaken for real ServiceNow evidence in a subsequent live session.
        resetDemoWriteState();
        setDemoMode(!demoMode);
      }}
    >
      <i aria-hidden="true" />
      <span>demo</span>
    </button>
  );
}
