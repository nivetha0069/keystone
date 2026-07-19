// Read-only AI usage for a single Migration Run.
// Forwards to the scoped bridge endpoint (/usage) so the browser never touches
// protected ServiceNow global tables (e.g. sys_generative_ai_metric) directly.
// Credentials stay server-side, mirroring the [resource] route auth pattern.

function authorizationHeader() {
  if (process.env.CMDB_API_TOKEN) return `Bearer ${process.env.CMDB_API_TOKEN}`;
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return `Basic ${btoa(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`)}`;
  }
  return undefined;
}

function usageUrl() {
  const base = process.env.CMDB_API_BASE_URL?.replace(/\/$/, "");
  if (!base) return null;
  return `${base}/usage`;
}

export async function GET(request: Request) {
  const run = new URL(request.url).searchParams.get("run")?.trim();
  if (!run) return Response.json({ error: "A migration run sys_id is required", unavailable: "Missing run" }, { status: 400 });

  let url = usageUrl();
  if (!url) return Response.json({ error: "CMDB_API_BASE_URL is not configured", unavailable: "Not configured" }, { status: 503 });
  url += `?run=${encodeURIComponent(run)}`;

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
    return Response.json(
      { error: "AI usage endpoint is unreachable", unavailable: "Unreachable", detail: error instanceof Error ? error.message : "Unknown error" },
      { status: 502 },
    );
  }
}
