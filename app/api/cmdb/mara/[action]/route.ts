// Mara's advisory endpoint.
//
// This is a read-only *ask* path, not a write path. It forwards one question and
// one run id to ServiceNow and returns prose. It cannot stage, simulate,
// approve, execute, or verify anything: IRE remains the only route into the
// CMDB, and nothing here can reach it.
//
// The outgoing payload is reconstructed field by field, exactly like the IRE and
// remediate routes, so a browser cannot smuggle table names, encoded queries,
// class names, or CMDB values through the question channel.

const ACTIONS = new Set(["chat"]);

const MAX_QUESTION_LENGTH = 400;
const MAX_HISTORY_TURNS = 6;
const MAX_HISTORY_LENGTH = 400;

function authorizationHeader() {
  if (process.env.CMDB_API_TOKEN) return `Bearer ${process.env.CMDB_API_TOKEN}`;
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return `Basic ${btoa(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`)}`;
  }
  return undefined;
}

function maraChatUrl() {
  const explicit = process.env.CMDB_MARA_CHAT_URL;
  if (explicit) return explicit;
  const base = process.env.CMDB_API_BASE_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/mara/chat`;
}

export async function GET(_request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (!ACTIONS.has(action)) return Response.json({ error: "Unknown Mara action" }, { status: 404 });
  return Response.json({ error: "Use POST for this Mara action" }, { status: 405 });
}

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  if (!ACTIONS.has(action)) return Response.json({ error: "Unknown Mara action" }, { status: 404 });

  const incoming = await request.json().catch(() => ({})) as Record<string, unknown>;
  const body = sanitizeMaraChatRequest(incoming);
  if (!body.migration_run_id) {
    return Response.json({ error: "Invalid Mara request", missing: ["migration_run_id"] }, { status: 400 });
  }
  if (!body.question) {
    return Response.json({ error: "Invalid Mara request", missing: ["question"] }, { status: 400 });
  }

  const url = maraChatUrl();
  if (!url) return Response.json({ error: "Mara advisory endpoint is not configured" }, { status: 503 });

  const authorization = authorizationHeader();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...(authorization ? { authorization } : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const responseBody = await response.text();
    return new Response(responseBody, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json({
      error: "Mara advisory endpoint is unreachable",
      detail: error instanceof Error ? error.message : "Unknown error",
    }, { status: 502 });
  }
}

/**
 * Rebuild the outgoing payload from an explicit field list.
 *
 * `context` carries only the counts the dashboard already derived, so
 * ServiceNow can see what the operator is looking at without the browser being
 * able to assert anything the backend would then trust as evidence. Every value
 * is coerced to a non-negative integer or a short enum string.
 */
export function sanitizeMaraChatRequest(incoming: Record<string, unknown>) {
  const rawContext = isRecord(incoming.context) ? incoming.context : {};
  const rawCounts = isRecord(rawContext.counts) ? rawContext.counts : {};

  return {
    migration_run_id: identifier(incoming.migration_run_id ?? incoming.migrationRunId),
    question: text(incoming.question, MAX_QUESTION_LENGTH),
    // Advisory only. ServiceNow must refuse to act on this request whatever it
    // says, and this field records that intent explicitly on the wire.
    mode: "advisory" as const,
    history: history(incoming.history),
    context: {
      run_state: token(rawContext.run_state ?? rawContext.runState),
      api_state: token(rawContext.api_state ?? rawContext.apiState),
      active_phase: token(rawContext.active_phase ?? rawContext.activePhase),
      counts: {
        staged: count(rawCounts.staged),
        verified: count(rawCounts.verified),
        executing: count(rawCounts.executing),
        ready_to_simulate: count(rawCounts.readyToSimulate ?? rawCounts.ready_to_simulate),
        held: count(rawCounts.held),
        approvals: count(rawCounts.approvals),
        work_groups: count(rawCounts.workGroups ?? rawCounts.work_groups),
      },
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function identifier(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : "";
}

function text(value: unknown, max: number) {
  if (typeof value !== "string") return "";
  // Collapse newlines so a question cannot carry a fabricated multi-line
  // "system" block into the prompt the ServiceNow side builds.
  return value.replace(/[\r\n\t]+/g, " ").trim().slice(0, max);
}

function token(value: unknown) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9_-]{1,40}$/.test(candidate) ? candidate : "";
}

function count(value: unknown) {
  const parsed = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed < 0) return 0;
  return Math.min(Math.floor(parsed), 1_000_000);
}

function history(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value
    .slice(-MAX_HISTORY_TURNS)
    .map(turn => {
      if (!isRecord(turn)) return null;
      const role = turn.role === "mara" ? "mara" : turn.role === "user" ? "user" : "";
      const content = text(turn.text ?? turn.content, MAX_HISTORY_LENGTH);
      if (!role || !content) return null;
      return { role, text: content };
    })
    .filter((turn): turn is { role: string; text: string } => turn !== null);
}
