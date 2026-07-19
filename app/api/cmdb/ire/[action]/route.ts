import { IreAction, isIreAction } from "../../../../lib/cmdb/ire";

const POST_ACTIONS = new Set<IreAction>(["simulate", "approve", "execute", "verify"]);

function authorizationHeader() {
  if (process.env.CMDB_API_TOKEN) return `Bearer ${process.env.CMDB_API_TOKEN}`;
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return `Basic ${btoa(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`)}`;
  }
  return undefined;
}

function ireActionUrl(action: IreAction) {
  const explicit = process.env[`CMDB_IRE_${action.toUpperCase()}_URL`];
  if (explicit) return explicit;

  const base = (process.env.CMDB_IRE_BASE_URL || process.env.CMDB_API_BASE_URL)?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/ire/${action}`;
}

export async function GET(_request: Request, context: { params: Promise<{ action: string }> }) {
  const action = await requestedAction(context);
  if (!action) return Response.json({ error: "Unknown IRE action" }, { status: 404 });
  return Response.json({ error: "Use POST for this IRE action" }, { status: 405 });
}

export async function POST(request: Request, context: { params: Promise<{ action: string }> }) {
  const action = await requestedAction(context);
  if (!action) return Response.json({ error: "Unknown IRE action" }, { status: 404 });
  if (!POST_ACTIONS.has(action)) return Response.json({ error: "Unknown IRE action" }, { status: 404 });

  const incoming = await request.json().catch(() => ({})) as Record<string, unknown>;
  return proxyIreAction(action, sanitizeIreRequest(action, incoming));
}

async function requestedAction(context: { params: Promise<{ action: string }> }) {
  const { action } = await context.params;
  return isIreAction(action) ? action : null;
}

async function proxyIreAction(action: IreAction, body: Record<string, string>) {
  const missing = requiredFields(action).filter(field => !body[field]);
  if (missing.length) {
    return Response.json({ error: "Invalid IRE request", missing }, { status: 400 });
  }

  const url = ireActionUrl(action);
  if (!url) return Response.json({ error: "ServiceNow IRE endpoint is not configured" }, { status: 503 });

  const authorization = authorizationHeader();
  const headers: HeadersInit = { accept: "application/json", ...(authorization ? { authorization } : {}) };

  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers, "content-type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const responseBody = await response.text();
    return new Response(responseBody, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json({ error: "ServiceNow IRE endpoint is unreachable", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}

function sanitizeIreRequest(action: IreAction, incoming: Record<string, unknown>) {
  const base = {
    migration_run_id: value(incoming.migration_run_id ?? incoming.migrationRunId),
    staged_ci_id: value(incoming.staged_ci_id ?? incoming.stagedCiId),
    correlation_id: value(incoming.correlation_id ?? incoming.correlationId),
    idempotency_key: value(incoming.idempotency_key ?? incoming.idempotencyKey),
  };

  if (action === "approve") {
    return {
      ...base,
      decision: value(incoming.decision),
      rationale: value(incoming.rationale),
      simulation_correlation_id: value(incoming.simulation_correlation_id ?? incoming.simulationCorrelationId),
    };
  }

  if (action === "execute") {
    return {
      ...base,
      simulation_correlation_id: value(incoming.simulation_correlation_id ?? incoming.simulationCorrelationId),
    };
  }

  if (action === "verify") {
    return {
      ...base,
      execution_correlation_id: value(incoming.execution_correlation_id ?? incoming.executionCorrelationId),
    };
  }

  return base;
}

function requiredFields(action: IreAction) {
  const base = ["migration_run_id", "staged_ci_id", "correlation_id", "idempotency_key"];
  if (action === "approve") return [...base, "decision", "rationale"];
  if (action === "execute") return [...base, "simulation_correlation_id"];
  if (action === "verify") return [...base, "execution_correlation_id"];
  return base;
}

function value(input: unknown) {
  return input === undefined || input === null ? "" : String(input).trim();
}

