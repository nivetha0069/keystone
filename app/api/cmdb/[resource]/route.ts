const READ_RESOURCES = new Set(["cis", "timeline", "relationships", "health", "findings", "reviews", "run"]);

function authorizationHeader() {
  if (process.env.CMDB_API_TOKEN) return `Bearer ${process.env.CMDB_API_TOKEN}`;
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return `Basic ${btoa(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`)}`;
  }
  return undefined;
}

function upstreamUrl(resource: string) {
  const base = process.env.CMDB_API_BASE_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/${resource}`;
}

function importUrl() {
  return process.env.CMDB_IMPORT_URL || upstreamUrl("import");
}

export async function GET(request: Request, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params;
  if (!READ_RESOURCES.has(resource)) return Response.json({ error: "Unknown CMDB resource" }, { status: 404 });
 /* const url = upstreamUrl(resource);
  if (!url) return Response.json({ error: "CMDB_API_BASE_URL is not configured" }, { status: 503 }); */
let url = upstreamUrl(resource);
  if (!url) return Response.json({ error: "CMDB_API_BASE_URL is not configured" }, { status: 503 });
  const search = new URL(request.url).search;
  if (search) url += search;

  const authorization = authorizationHeader();
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...(authorization ? { authorization } : {}) },
      cache: "no-store",
    });
    const body = await response.text();
    return new Response(body, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json({ error: "CMDB API is unreachable", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}

export async function POST(request: Request, context: { params: Promise<{ resource: string }> }) {
  const { resource } = await context.params;
  if (resource === "import") {
    const url = importUrl();
    if (!url) return Response.json({ error: "Import staging is not configured" }, { status: 503 });

    const length = Number(request.headers.get("content-length") || 0);
    if (length > 11 * 1024 * 1024) return Response.json({ error: "Import payload exceeds the 10 MB gateway limit" }, { status: 413 });

    const authorization = authorizationHeader();
    const contentType = request.headers.get("content-type") || "";
    try {
      let body: BodyInit;
      let headers: HeadersInit = { accept: "application/json", ...(authorization ? { authorization } : {}) };

      if (contentType.includes("multipart/form-data")) {
        const incoming = await request.formData();
        incoming.set("target", "staging");
        incoming.set("mode", "quarantine");
        incoming.set("directCmdbWrite", "false");
        body = incoming;
      } else {
        const incoming = await request.json().catch(() => ({})) as Record<string, unknown>;
        body = JSON.stringify({
          sourceType: incoming.sourceType,
          sourceName: incoming.sourceName,
          runName: incoming.runName,
          sourceUrl: incoming.sourceUrl,
          sourceFileName: incoming.sourceFileName,
          format: incoming.format,
          payload: incoming.payload,
          target: "staging",
          mode: "quarantine",
          directCmdbWrite: false,
        });
        headers = { ...headers, "content-type": "application/json" };
      }

      const response = await fetch(url, { method: "POST", headers, body });
      const responseBody = await response.text();
      return new Response(responseBody, {
        status: response.status,
        headers: { "content-type": response.headers.get("content-type") || "application/json" },
      });
    } catch (error) {
      return Response.json({ error: "Import staging endpoint is unreachable", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
    }
  }

  if (resource !== "remediate") return Response.json({ error: "Writes are not allowed on this route" }, { status: 405 });
  const configuredUrl = process.env.CMDB_REMEDIATE_URL;
  const url = configuredUrl || upstreamUrl("remediate");
  if (!url) return Response.json({ error: "Remediation is not configured" }, { status: 503 });

  const incoming = await request.json().catch(() => ({})) as Record<string, unknown>;
  const rawRunId = incoming.migration_run_id ?? incoming.migrationRunId;
  const rawStagedCiId = incoming.staged_ci_id ?? incoming.stagedCiId;
  const migrationRunId = identifier(rawRunId);
  const stagedCiId = identifier(rawStagedCiId);
  const findingId = identifier(incoming.finding_id);
  const correlationId = token(incoming.correlation_id);
  const idempotencyKey = token(incoming.idempotency_key);
  const simulationCorrelationId = token(incoming.simulation_correlation_id);
  const simulationFingerprint = fingerprint(incoming.simulation_fingerprint);
  if (!migrationRunId || !stagedCiId || !findingId || !correlationId || !idempotencyKey ||
      !simulationCorrelationId || !simulationFingerprint) {
    const missing: string[] = [];
    if (!migrationRunId) missing.push("migration_run_id");
    if (!stagedCiId) missing.push("staged_ci_id");
    if (!findingId) missing.push("finding_id");
    if (!correlationId) missing.push("correlation_id");
    if (!idempotencyKey) missing.push("idempotency_key");
    if (!simulationCorrelationId) missing.push("simulation_correlation_id");
    if (!simulationFingerprint) missing.push("simulation_fingerprint");
    return Response.json({
      error: "Invalid remediate request: exact proposal identifiers and canonical simulation evidence are required.",
      missing,
    }, { status: 400 });
  }
  const body = JSON.stringify({
    migration_run_id: migrationRunId,
    staged_ci_id: stagedCiId,
    finding_id: findingId,
    correlation_id: correlationId,
    idempotency_key: idempotencyKey,
    simulation_correlation_id: simulationCorrelationId,
    simulation_fingerprint: simulationFingerprint,
    mode: "proposal",
  });
  const authorization = authorizationHeader();
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json", ...(authorization ? { authorization } : {}) },
      body,
    });
    const responseBody = await response.text();
    return new Response(responseBody, {
      status: response.status,
      headers: { "content-type": response.headers.get("content-type") || "application/json" },
    });
  } catch (error) {
    return Response.json({ error: "IRE remediation endpoint is unreachable", detail: error instanceof Error ? error.message : "Unknown error" }, { status: 502 });
  }
}

function identifier(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toLowerCase() : "";
  return /^[0-9a-f]{32}$/.test(candidate) ? candidate : "";
}

function token(value: unknown) {
  const candidate = typeof value === "string" ? value.trim() : "";
  return /^[a-zA-Z0-9:._-]{1,180}$/.test(candidate) ? candidate : "";
}

function fingerprint(value: unknown) {
  const candidate = typeof value === "string" ? value.trim().toUpperCase() : "";
  return /^[0-9A-F]{64}$/.test(candidate) ? candidate : "";
}
