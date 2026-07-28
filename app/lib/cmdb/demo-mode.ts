// Manual demo mode.
//
// Keystone's frontend is deliberately an honest window onto ServiceNow: commit
// a3c79f2 removed the old automatic mock fallback because silently backfilling
// missing fields hid real backend bugs. This module reintroduces simulated data
// as an *explicitly toggled* mode instead — never automatic, so a genuine
// backend failure still fails loudly and visibly.
//
// The state lives at module scope rather than in React so `cmdbFetch` can read
// it synchronously from anywhere, including outside the component tree.
//
// Hydration: the initial value is always `false`, matching what the server
// renders. `restoreDemoMode()` must be called from an effect after hydration;
// it reads the URL first, then localStorage, and notifies subscribers.

const STORAGE_KEY = "keystone.demo";
const URL_PARAM = "demo";

let enabled = false;
let epoch = 0;
let restored = false;
const listeners = new Set<() => void>();

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch { return null; }
}

function notify() {
  for (const listener of [...listeners]) listener();
}

/** True while the app is serving simulated data instead of calling ServiceNow. */
export function isDemoMode(): boolean {
  return enabled;
}

/**
 * Monotonic counter bumped on every mode change. Async handlers capture it
 * before awaiting and drop their results if it moved, so a live response that
 * lands after the toggle can never overwrite simulated state (or vice versa).
 */
export function demoEpoch(): number {
  return epoch;
}

/** True once `restoreDemoMode` has run, i.e. the browser-only value is known. */
export function demoModeReady(): boolean {
  return restored;
}

export function setDemoMode(next: boolean): void {
  if (enabled === next) return;
  enabled = next;
  epoch += 1;
  const storage = safeStorage();
  try {
    if (next) storage?.setItem(STORAGE_KEY, "1");
    else storage?.removeItem(STORAGE_KEY);
  } catch { /* private mode / quota — the in-memory value still applies */ }
  notify();
}

/**
 * Resolve the persisted value after hydration. `?demo=1` wins over localStorage
 * so a link can force the mode; `?demo=0` explicitly forces it off.
 */
export function restoreDemoMode(): boolean {
  if (typeof window === "undefined") return false;
  restored = true;
  let next = false;
  try {
    const param = new URL(window.location.href).searchParams.get(URL_PARAM);
    if (param === "1" || param === "true") next = true;
    else if (param === "0" || param === "false") next = false;
    else next = safeStorage()?.getItem(STORAGE_KEY) === "1";
  } catch { next = false; }

  if (next === enabled) {
    notify();
    return enabled;
  }
  enabled = next;
  epoch += 1;
  notify();
  return enabled;
}

export function subscribeDemoMode(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Snapshot used by `useSyncExternalStore` during server rendering. */
export function demoModeServerSnapshot(): boolean {
  return false;
}

/**
 * Keep `?demo=1` in the address bar in sync with the mode, without disturbing
 * the `run` parameter — toggling demo mode off must return the user to the real
 * run they were looking at.
 */
export function syncDemoModeUrl(): void {
  if (typeof window === "undefined") return;
  try {
    const url = new URL(window.location.href);
    const current = url.searchParams.get(URL_PARAM);
    if (enabled) {
      if (current === "1") return;
      url.searchParams.set(URL_PARAM, "1");
    } else {
      if (current === null) return;
      url.searchParams.delete(URL_PARAM);
    }
    window.history.replaceState({}, "", url);
  } catch { /* ignore */ }
}
