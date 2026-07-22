import "server-only";

import type { HealthData } from "../../cmdb-data";
import {
  normalizeComprehendCis,
  normalizeComprehendHealth,
  normalizeComprehendRelationships,
  normalizeComprehendTimeline,
  normalizeRemediationFindings,
  normalizeRemediationReviews,
} from "./comprehend-adapter";
import { normalizeIreActionResponse, type IreAction, type IreActionError, type IreActionResponse } from "./ire";
import type { RemediationCampaignSnapshot } from "./remediation-campaign";

const CAMPAIGN_READ_RESOURCES = ["cis", "timeline", "findings", "reviews", "health", "relationships"] as const;

export async function loadCampaignSnapshot(migrationRunId: string): Promise<RemediationCampaignSnapshot> {
  if (!/^[0-9a-f]{32}$/i.test(migrationRunId)) throw bridgeError("INVALID_REQUEST", "A canonical migration run sys_id is required.");
  const results = await Promise.all(CAMPAIGN_READ_RESOURCES.map(resource => fetchCmdbResource(resource, migrationRunId)));
  const health = normalizeComprehendHealth(results[4]);
  return {
    migrationRunId: migrationRunId.toLowerCase(),
    cis: normalizeComprehendCis(results[0]),
    timeline: normalizeComprehendTimeline(results[1]),
    findings: normalizeRemediationFindings(results[2]),
    reviews: normalizeRemediationReviews(results[3]),
    health: health.fixes ? health : emptyHealth(),
    relationships: normalizeComprehendRelationships(results[5]),
  };
}

export async function invokeCampaignIre(
  action: "simulate" | "approve",
  body: Record<string, string>,
): Promise<IreActionResponse> {
  const url = ireActionUrl(action);
  if (!url) return failedResponse(action, "NOT_CONFIGURED", "ServiceNow IRE endpoint is not configured.");
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
        ...(authorizationHeader() ? { authorization: authorizationHeader()! } : {}),
      },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const payload = await response.json().catch(() => ({}));
    const normalized = normalizeIreActionResponse(action, payload);
    if (response.ok) return normalized;
    return {
      ...normalized,
      success: false,
      error: normalized.error ?? httpError(response.status, payload),
    };
  } catch (error) {
    return failedResponse(action, "UPSTREAM_UNREACHABLE", error instanceof Error ? error.message : "ServiceNow IRE endpoint is unreachable.");
  }
}

async function fetchCmdbResource(resource: typeof CAMPAIGN_READ_RESOURCES[number], migrationRunId: string) {
  const base = process.env.CMDB_API_BASE_URL?.replace(/\/$/, "");
  if (!base) throw bridgeError("NOT_CONFIGURED", "CMDB_API_BASE_URL is not configured.");
  const url = new URL(`${base}/${resource}`);
  url.searchParams.set("run", migrationRunId);
  try {
    const response = await fetch(url, {
      headers: { accept: "application/json", ...(authorizationHeader() ? { authorization: authorizationHeader()! } : {}) },
      cache: "no-store",
    });
    const text = await response.text();
    if (!response.ok) throw bridgeError(httpCode(response.status), `${resource} returned HTTP ${response.status}: ${text.slice(0, 240)}`);
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw bridgeError("UPSTREAM_INVALID_RESPONSE", `${resource} returned invalid JSON.`);
    }
  } catch (error) {
    if (error instanceof Error && "code" in error) throw error;
    throw bridgeError("UPSTREAM_UNREACHABLE", error instanceof Error ? error.message : `${resource} is unreachable.`);
  }
}

function ireActionUrl(action: IreAction) {
  const explicit = process.env[`CMDB_IRE_${action.toUpperCase()}_URL`];
  if (explicit) return explicit;
  const base = (process.env.CMDB_IRE_BASE_URL || process.env.CMDB_API_BASE_URL)?.replace(/\/$/, "");
  return base ? `${base}/ire/${action}` : null;
}

function authorizationHeader() {
  if (process.env.CMDB_API_TOKEN) return `Bearer ${process.env.CMDB_API_TOKEN}`;
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return `Basic ${btoa(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`)}`;
  }
  return undefined;
}

function httpError(status: number, payload: unknown): IreActionError {
  const row = payload && typeof payload === "object" && !Array.isArray(payload) ? payload as Record<string, unknown> : {};
  const message = typeof row.error === "string" ? row.error : typeof row.message === "string" ? row.message : `IRE request failed with HTTP ${status}.`;
  return { code: httpCode(status) as IreActionError["code"], message, details: row.details ?? row.detail ?? row.missing };
}

function httpCode(status: number) {
  if (status === 400) return "INVALID_REQUEST";
  if (status === 401) return "UNAUTHORIZED";
  if (status === 403) return "FORBIDDEN";
  if (status === 404) return "NOT_FOUND";
  if (status === 503) return "NOT_CONFIGURED";
  return "UPSTREAM_UNREACHABLE";
}

function failedResponse(action: "simulate" | "approve", code: IreActionError["code"], message: string): IreActionResponse {
  return {
    success: false,
    action,
    state: action === "simulate" ? "simulation_failed" : "approved_for_execution",
    error: { code, message },
  };
}

function bridgeError(code: string, message: string) {
  const error = new Error(message) as Error & { code: string };
  error.code = code;
  return error;
}

function emptyHealth(): HealthData {
  return {
    score: 0,
    grade: "—",
    ciCount: 0,
    duplicateCandidates: 0,
    reviewCount: 0,
    relationshipCount: 0,
    completeness: 0,
    correctness: 0,
    compliance: 0,
    duplicateRate: 0,
    staleRecords: 0,
    fixes: [],
  };
}
