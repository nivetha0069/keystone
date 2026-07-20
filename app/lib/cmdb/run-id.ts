// Extracts the migration-run identity from a ServiceNow import/staging response.
//
// The staging response may nest its payload inside standard envelopes
// (`result`, `data`, `items`, `records`, arrays of those) and may also echo
// staged-CI records that carry their own 32-character sys_id. Ownership is
// semantic: only a field that explicitly names the migration run may supply
// the id. A staged CI, finding, review or relationship record must never be
// promoted to a migration run just because its sys_id looks valid.

export type ImportedRun = { id: string; label: string };

// Keys that carry the number of staged CI rows created by an import response.
const STAGED_COUNT_KEYS = ["staged", "stagedCount", "staged_count", "stagedCiCount", "staged_ci_count"] as const;

// A ServiceNow sys_id is exactly 32 hex characters.
const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;

export function isSysId(value: unknown): value is string {
  return typeof value === "string" && SYS_ID_PATTERN.test(value.trim());
}

// Wrapper keys a response may put around the real payload. Traversal descends
// ONLY through these (plus arrays), so sibling record collections such as
// `cis` or `staged_records` are never mined for ids.
const ENVELOPE_KEYS = ["result", "data", "items", "records"] as const;

// Keys that directly name the migration-run id. Highest priority, in order.
const RUN_ID_KEYS = ["migration_run_id", "migrationRunId", "run_id", "runId", "run_sys_id", "runSysId"] as const;

// Keys that hold either a run sys_id string or a run object. Second priority.
const RUN_OBJECT_KEYS = ["migration_run", "migrationRun", "run"] as const;

// Human-readable run identifiers, read only from run-scoped locations.
const RUN_OBJECT_LABEL_KEYS = ["number", "display_value", "name", "label"] as const;
const RUN_SCOPED_LABEL_KEYS = [
  "migration_run_number", "migrationRunNumber", "run_number", "runNumber", "run_name", "runName",
] as const;

type PlainObject = Record<string, unknown>;

function isPlainObject(value: unknown): value is PlainObject {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

/**
 * Collect the envelope objects of the response, shallowest first: the root,
 * plus anything reachable through ENVELOPE_KEYS and arrays. Arbitrary child
 * objects (staged CIs, findings, …) are deliberately not collected.
 */
function collectEnvelopes(root: unknown): PlainObject[] {
  const found: PlainObject[] = [];
  const seen = new Set<unknown>();
  let frontier: unknown[] = [root];

  for (let depth = 0; depth < 6 && frontier.length && found.length < 50; depth++) {
    const next: unknown[] = [];
    for (const node of frontier) {
      if (!node || typeof node !== "object" || seen.has(node)) continue;
      seen.add(node);
      if (Array.isArray(node)) {
        next.push(...node);
        continue;
      }
      const row = node as PlainObject;
      found.push(row);
      for (const key of ENVELOPE_KEYS) {
        const value = row[key];
        if (value && typeof value === "object") next.push(value);
      }
    }
    frontier = next;
  }
  return found;
}

// ServiceNow reference fields serialize as { value, link } or { sys_id, display_value }.
function referenceSysId(value: unknown): string {
  if (isSysId(value)) return value.trim();
  if (!isPlainObject(value)) return "";
  for (const candidate of [value.value, value.sys_id, value.id]) {
    if (isSysId(candidate)) return candidate.trim();
  }
  return "";
}

function labelFrom(source: PlainObject | undefined, keys: readonly string[]): string {
  if (!source) return "";
  for (const key of keys) {
    const value = source[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

/** Best run label for an envelope node: run-scoped keys, then any run object it holds. */
function runLabelFor(node: PlainObject): string {
  const direct = labelFrom(node, RUN_SCOPED_LABEL_KEYS);
  if (direct) return direct;
  for (const key of RUN_OBJECT_KEYS) {
    const value = node[key];
    if (isPlainObject(value)) {
      const label = labelFrom(value, RUN_OBJECT_LABEL_KEYS);
      if (label) return label;
    }
  }
  return "";
}

/**
 * Resolve the migration run named by an import/staging response.
 *
 * Only explicitly run-scoped fields qualify, in priority order:
 *  1. direct id keys — `migration_run_id`, `run_id`, `runId`, … on an envelope;
 *  2. `migration_run` / `run` holding a sys_id string or a run object.
 *
 * Returns an empty id when the response names no run; callers must treat that
 * as a hard failure rather than guessing from nested records.
 */
export function importedRunFromResponse(response: PlainObject, fallbackLabel: string): ImportedRun {
  const nodes = collectEnvelopes(response);

  for (const key of RUN_ID_KEYS) {
    for (const node of nodes) {
      const id = referenceSysId(node[key]);
      if (id) return { id, label: runLabelFor(node) || fallbackLabel };
    }
  }

  for (const key of RUN_OBJECT_KEYS) {
    for (const node of nodes) {
      const value = node[key];
      const id = referenceSysId(value);
      if (!id) continue;
      const label = (isPlainObject(value) && labelFrom(value, RUN_OBJECT_LABEL_KEYS)) || runLabelFor(node);
      return { id, label: label || fallbackLabel };
    }
  }

  return { id: "", label: fallbackLabel };
}

/**
 * Number of staged CI rows named by an import response. An explicit `0` means
 * the source produced no CIs and Comprehend must not run; callers use that to
 * warn the user and hold the run in place instead of navigating into it.
 * Returns `undefined` when the response simply omits the count.
 */
export function stagedCountFromResponse(response: unknown): number | undefined {
  const nodes = collectEnvelopes(response);
  for (const key of STAGED_COUNT_KEYS) {
    for (const node of nodes) {
      const value = node[key];
      if (typeof value === "number" && Number.isFinite(value)) return value;
      if (typeof value === "string" && value.trim() && Number.isFinite(Number(value))) return Number(value);
    }
  }
  return undefined;
}
