// Client-side run registry. ServiceNow exposes single-run reads but no
// list-all-runs endpoint, so the frontend remembers what the current user
// has imported or opened. Persisted to localStorage; every insert
// deduplicates by sys_id and bumps the entry to the top so recent work is
// visible.
//
// Not a source of truth — every consumer must re-fetch /run to confirm the
// backend's current state before showing anything to the user.

const STORAGE_KEY = "keystone.run.registry.v1";
const MAX_ENTRIES = 20;

export type RegistryEntry = {
  id: string;
  label: string;
  summary?: string;
  sourceSystem?: string;
  runNumber?: string;
  /** ISO timestamp of the last time the user touched this run. */
  touchedAt: string;
  /** True if imported this session (vs. opened by pasting a sys_id). */
  imported?: boolean;
};

const SYS_ID_RE = /^[0-9a-f]{32}$/i;

function safeStorage(): Storage | null {
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch { return null; }
}

export function readRegistry(): RegistryEntry[] {
  const storage = safeStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((entry): entry is RegistryEntry => entry && typeof entry === "object" && typeof entry.id === "string" && SYS_ID_RE.test(entry.id))
      .map(entry => ({
        id: entry.id.toLowerCase(),
        label: typeof entry.label === "string" ? entry.label : `RUN-${entry.id.slice(0, 8).toUpperCase()}`,
        summary: typeof entry.summary === "string" ? entry.summary : undefined,
        sourceSystem: typeof entry.sourceSystem === "string" ? entry.sourceSystem : undefined,
        runNumber: typeof entry.runNumber === "string" ? entry.runNumber : undefined,
        touchedAt: typeof entry.touchedAt === "string" ? entry.touchedAt : "",
        imported: Boolean(entry.imported),
      }));
  } catch { return []; }
}

function writeRegistry(entries: RegistryEntry[]): void {
  const storage = safeStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch { /* quota / private mode — silently drop */ }
}

/** Insert-or-refresh. Dedupes by sys_id, bumps to the top, keeps max 20. */
export function rememberRunEntry(input: Partial<RegistryEntry> & { id: string; label?: string; touchedAt?: string }): RegistryEntry[] {
  if (!SYS_ID_RE.test(input.id)) return readRegistry();
  const now = input.touchedAt || new Date().toISOString();
  const existing = readRegistry();
  const filtered = existing.filter(entry => entry.id.toLowerCase() !== input.id.toLowerCase());
  const merged: RegistryEntry = {
    id: input.id.toLowerCase(),
    label: input.label || existing.find(e => e.id.toLowerCase() === input.id.toLowerCase())?.label || `RUN-${input.id.slice(0, 8).toUpperCase()}`,
    summary: input.summary,
    sourceSystem: input.sourceSystem,
    runNumber: input.runNumber,
    touchedAt: now,
    imported: Boolean(input.imported),
  };
  const next = [merged, ...filtered];
  writeRegistry(next);
  return next;
}

export function forgetRunEntry(id: string): RegistryEntry[] {
  const next = readRegistry().filter(entry => entry.id.toLowerCase() !== id.toLowerCase());
  writeRegistry(next);
  return next;
}

export function clearRegistry(): void {
  const storage = safeStorage();
  if (!storage) return;
  try { storage.removeItem(STORAGE_KEY); } catch { /* ignore */ }
}

// ----- Queue helpers -----

const TERMINAL_STATES = new Set(["completed", "cancelled", "failed", "closed", "terminal", "done", "verified", "rejected"]);

export function isRunTerminal(state: string | undefined | null): boolean {
  if (!state) return false;
  return TERMINAL_STATES.has(state.trim().toLowerCase());
}
