// Shared migration-run resolution used by every route that operates on one run.
//
// The dashboard and the AI Usage page both need to answer the same question:
// "which migration run is the user looking at?". Duplicating the localStorage
// key and the URL-parsing logic across pages let AI Usage silently diverge —
// it read `?run=` but never fell back to the saved run, which is why users had
// to paste the sys_id by hand. This module owns that resolution end-to-end so
// no page has to remember the key or the priority order.

import { isSysId } from "./run-id";

export { isSysId } from "./run-id";

export const ACTIVE_RUN_STORAGE_KEY = "cmdb-modernization:last-run-id";

function safeStorage(): Storage | null {
  if (typeof window === "undefined") return null;
  try { return window.localStorage; } catch { return null; }
}

/** `?run=<id>` from the current URL, or "" if absent/invalid. Client-only. */
export function readRunFromUrl(): string {
  if (typeof window === "undefined") return "";
  const raw = new URLSearchParams(window.location.search).get("run")?.trim() || "";
  return isSysId(raw) ? raw : "";
}

/** Last remembered run, or "" if none/invalid. Ignores corrupt values silently. */
export function readSavedRun(): string {
  const storage = safeStorage();
  if (!storage) return "";
  const raw = storage.getItem(ACTIVE_RUN_STORAGE_KEY)?.trim() || "";
  return isSysId(raw) ? raw : "";
}

/**
 * Resolve the active run: URL first, then localStorage. Returns "" when the
 * user has never selected a run. Never accepts a value that isn't a sys_id —
 * that guard is what stops a stray localStorage entry from becoming a request
 * argument.
 */
export function resolveActiveRun(): string {
  return readRunFromUrl() || readSavedRun();
}

/** Persist (or clear) the active run. Empty string clears the key. */
export function rememberRun(runId: string): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    if (runId && isSysId(runId)) storage.setItem(ACTIVE_RUN_STORAGE_KEY, runId);
    else storage.removeItem(ACTIVE_RUN_STORAGE_KEY);
  } catch { /* private mode / quota — nothing we can do */ }
}

/**
 * Reflect the run in the URL without a full navigation. No-op when the URL is
 * already correct, so it is safe to call from a mount effect.
 */
export function writeRunToUrl(runId: string): void {
  if (typeof window === "undefined") return;
  const url = new URL(window.location.href);
  const current = url.searchParams.get("run") || "";
  if (runId && isSysId(runId)) {
    if (current === runId) return;
    url.searchParams.set("run", runId);
  } else {
    if (!current) return;
    url.searchParams.delete("run");
  }
  window.history.replaceState({}, "", url);
}
