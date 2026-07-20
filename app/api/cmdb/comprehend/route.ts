// Starts the ServiceNow Comprehend pipeline for one migration run.
//
// The browser may only name the run. Everything else — classes, findings,
// scores, payload values, agent outputs — is derived server-side by
// DotwalkersComprehendAgent. The outgoing body is rebuilt here so no browser
// field can reach ServiceNow, mirroring the /remediate route's contract.
//
// Comprehend queues Mara, and Mara queues Prioritize, so this is the only
// pipeline trigger the frontend ever calls.

const SYS_ID_PATTERN = /^[0-9a-f]{32}$/i;

function authorizationHeader() {
  if (process.env.CMDB_API_TOKEN) return `Bearer ${process.env.CMDB_API_TOKEN}`;
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return `Basic ${btoa(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`)}`;
  }
  return undefined;
}

function comprehendUrl() {
  if (process.env.CMDB_COMPREHEND_URL) return process.env.CMDB_COMPREHEND_URL;
  const base = process.env.CMDB_API_BASE_URL?.replace(/\/$/, "");
  return base ? `${base}/comprehend` : null;
}

export async function POST(request: Request) {
  const incoming = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const runId = typeof incoming.migration_run_id === "string" ? incoming.migration_run_id.trim() : "";

  if (!SYS_ID_PATTERN.test(runId)) {
    return Response.json({ error: "A valid migration_run_id (32-character sys_id) is required." }, { status: 400 });
  }

  const url = comprehendUrl();
  if (!url) {
    return Response.json({ error: "Comprehend is not configured. Set CMDB_COMPREHEND_URL or CMDB_API_BASE_URL." }, { status: 503 });
  }

  const authorization = authorizationHeader();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(authorization ? { authorization } : {}) },
      // Rebuilt payload: only the run id crosses the boundary.
      body: JSON.stringify({ migration_run_id: runId }),
      cache: "no-store",
    });
    const body = await response.text();
    // ServiceNow answers 409 when Comprehend was already queued (it starts the
    // pipeline during import itself). That is a benign outcome, not a failure,
    // so normalize it to 200 rather than leaving a spurious console error.
    let status = response.status;
    if (status === 409) {
      try {
        const parsed = JSON.parse(body) as Record<string, unknown>;
        const payload = parsed.result && typeof parsed.result === "object" && !Array.isArray(parsed.result)
          ? parsed.result as Record<string, unknown>
          : parsed;
        if (payload.already_running === true || payload.alreadyRunning === true) status = 200;
      } catch {}
    }
    return new Response(body, {
      status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json(
      { error: "Comprehend endpoint is unreachable", detail: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
