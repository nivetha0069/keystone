// Source adapters — deterministic transformers from a foreign JSON schema
// into Keystone's canonical StagingCiDraft shape. Each adapter is:
//
//   - Pure. No fetches, no side effects, no I/O.
//   - Deterministic. Same input → same output. No LLM inference.
//   - Named. Users pick the adapter explicitly at import time so the
//     transformation decision is auditable (not "we guessed this looks like
//     network CIs").
//
// This is intentionally a small library, not a plugin system. Every new
// adapter is a schema decision that a CMDB architect should approve; the
// registry file is a single place to see the full list.
//
// Adapters produce { cis, relationships } in the same shape
// buildStructuredStagingPayload emits, so the /api/cmdb/import route on the
// ServiceNow side treats adapter output identically to a normalized CSV.

import {
  CSV_PARSER_VERSION,
  type PreviewRow,
  type StagingCiDraft,
  type StagingRelationshipDraft,
  type StructuredStagingPayload,
} from "./import-staging";

export type SourceAdapterId =
  | "passthrough"
  | "aws-ip-ranges"
  | "statuspage-components";

export type AdapterMatchStrength = "high" | "low" | "none";

export type SourceAdapter = {
  id: SourceAdapterId;
  label: string;
  description: string;
  /** Human-readable target CI class this adapter emits. */
  producesClass: string;
  /**
   * Heuristic — does this payload look like it belongs to this adapter?
   * Returned strength lets the UI mark one adapter as recommended without
   * hiding the others. Never claims certainty.
   */
  detect(payload: unknown): AdapterMatchStrength;
  /**
   * Transform the payload into a StructuredStagingPayload. If the adapter
   * cannot make sense of the payload it throws SourceAdapterError with a
   * user-actionable message.
   */
  transform(payload: unknown, context: { sourceName: string }): StructuredStagingPayload;
};

export class SourceAdapterError extends Error {
  adapterId: SourceAdapterId;
  constructor(adapterId: SourceAdapterId, message: string) {
    super(message);
    this.name = "SourceAdapterError";
    this.adapterId = adapterId;
  }
}

// ---------------------------------------------------------------------------
// AWS IP Ranges — https://ip-ranges.amazonaws.com/ip-ranges.json
// { syncToken, createDate, prefixes: [{ ip_prefix, region, service, network_border_group }] }
// Each prefix becomes one cmdb_ci_ip_network record.
// ---------------------------------------------------------------------------

const awsIpRangesAdapter: SourceAdapter = {
  id: "aws-ip-ranges",
  label: "AWS IP Ranges",
  description: "AWS public prefix list — each prefix becomes a network CI tagged by region and service.",
  producesClass: "cmdb_ci_ip_network",
  detect(payload) {
    if (!isRecord(payload)) return "none";
    if (Array.isArray((payload as Record<string, unknown>).prefixes)
        && typeof (payload as Record<string, unknown>).syncToken === "string") return "high";
    return "none";
  },
  transform(payload, context) {
    if (!isRecord(payload) || !Array.isArray(payload.prefixes)) {
      throw new SourceAdapterError("aws-ip-ranges", "Payload does not contain an AWS `prefixes` array.");
    }
    const prefixes = payload.prefixes as Array<Record<string, unknown>>;
    const cis: StagingCiDraft[] = prefixes.map((prefix, index) => {
      const ipPrefix = strOr(prefix.ip_prefix, "");
      const region = strOr(prefix.region, "unknown");
      const service = strOr(prefix.service, "unknown");
      const nativeKey = `aws-prefix-${service}-${region}-${ipPrefix}`.toLowerCase().replace(/[^a-z0-9-.\/]/g, "-");
      const raw: PreviewRow = Object.fromEntries(
        Object.entries(prefix).map(([key, value]) => [key, value == null ? "" : String(value)]),
      );
      return {
        id: nativeKey,
        source_identifier: nativeKey,
        source_name: context.sourceName || "AWS IP Ranges",
        source_native_key: nativeKey,
        source_record_id: nativeKey,
        source_row_number: index + 1,
        parser_version: `${CSV_PARSER_VERSION}+aws-ip-ranges-v1`,
        name: `aws-${service.toLowerCase()}-${region}-${ipPrefix}`,
        host_name: ipPrefix,
        fqdn: ipPrefix,
        className: "cmdb_ci_ip_network",
        ci_class: "cmdb_ci_ip_network",
        ip_address: ipPrefix,
        environment: region,
        source: "AWS",
        support_group: service,
        team_identifier: `aws:${service}`,
        raw_row_json: raw,
        normalized_row_json: raw,
      };
    });
    return { parserVersion: `${CSV_PARSER_VERSION}+aws-ip-ranges-v1`, cis, relationships: [] };
  },
};

// ---------------------------------------------------------------------------
// Statuspage components — the schema used by Cloudflare / Fastly / Atlassian
// status pages and any Statuspage.io tenant.
//   { page: {...}, components: [{ id, name, status, description, group_id, group }] }
// Components become cmdb_ci_service records; group parents produce
// "member_of"-style staged relationships.
// ---------------------------------------------------------------------------

const statuspageAdapter: SourceAdapter = {
  id: "statuspage-components",
  label: "Statuspage components",
  description: "Cloudflare / Fastly / Atlassian / any Statuspage.io components → service CIs, with group parents as relationships.",
  producesClass: "cmdb_ci_service",
  detect(payload) {
    // Bare Statuspage array (components-only export)
    if (Array.isArray(payload) && payload.length > 0 && isRecord(payload[0])) {
      const first = payload[0] as Record<string, unknown>;
      if (typeof first.id === "string" && ("status" in first || "group_id" in first)) return "low";
    }
    if (!isRecord(payload)) return "none";
    const p = payload as Record<string, unknown>;
    if (Array.isArray(p.components) && p.components.length > 0) {
      const first = p.components[0];
      if (isRecord(first) && typeof (first as Record<string, unknown>).id === "string") return "high";
    }
    return "none";
  },
  transform(payload, context) {
    const componentsRaw = isRecord(payload) && Array.isArray((payload as Record<string, unknown>).components)
      ? (payload as Record<string, unknown>).components as Array<Record<string, unknown>>
      : Array.isArray(payload) ? payload as Array<Record<string, unknown>> : null;
    if (!componentsRaw) throw new SourceAdapterError("statuspage-components", "Payload is not a Statuspage components array or an object with a `components` array.");
    const cis: StagingCiDraft[] = componentsRaw.map((component, index) => {
      const id = strOr(component.id, `component-${index + 1}`);
      const name = strOr(component.name, `Unnamed component ${index + 1}`);
      const description = strOr(component.description, "");
      const status = strOr(component.status, "operational");
      const groupName = strOr(component.group ?? component.group_name, "");
      const raw: PreviewRow = Object.fromEntries(
        Object.entries(component).map(([key, value]) => [key, value == null ? "" : String(value)]),
      );
      return {
        id,
        source_identifier: id,
        source_name: context.sourceName || "Statuspage components",
        source_native_key: id,
        source_record_id: id,
        source_row_number: index + 1,
        parser_version: `${CSV_PARSER_VERSION}+statuspage-v1`,
        name,
        className: "cmdb_ci_service",
        ci_class: "cmdb_ci_service",
        environment: status,
        source: context.sourceName || "Statuspage",
        support_group: groupName,
        application_service: name,
        team_identifier: description ? description.slice(0, 60) : "",
        raw_row_json: raw,
        normalized_row_json: raw,
      };
    });
    const knownIds = new Set(cis.map(ci => ci.source_identifier));
    const relationships: StagingRelationshipDraft[] = [];
    const seen = new Set<string>();
    for (const component of componentsRaw) {
      const parentId = strOr(component.group_id, "");
      if (!parentId) continue;
      const childId = strOr(component.id, "");
      if (!childId || parentId === childId) continue;
      // Only emit relationships between CIs we actually staged — otherwise
      // the ServiceNow importer sees a dangling endpoint.
      if (!knownIds.has(parentId) || !knownIds.has(childId)) continue;
      const key = `${parentId}|${childId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      relationships.push({
        source: parentId,
        target: childId,
        source_relationship_type: "group_member",
        normalized_relationship_type: "Contains::Member of",
      });
    }
    return { parserVersion: `${CSV_PARSER_VERSION}+statuspage-v1`, cis, relationships };
  },
};

// ---------------------------------------------------------------------------
// Passthrough — no transformation. The default "I already have CMDB-shaped
// data" mode. Delegates to the existing structured CSV/JSON parser via the
// caller.
// ---------------------------------------------------------------------------

const passthroughAdapter: SourceAdapter = {
  id: "passthrough",
  label: "Passthrough (CMDB-shaped)",
  description: "Send the payload to ServiceNow as-is. Use when the source already carries CI-shaped rows.",
  producesClass: "auto",
  detect() { return "low"; },
  transform() {
    throw new SourceAdapterError("passthrough", "Passthrough adapter does not transform — send the raw payload directly.");
  },
};

export const sourceAdapters: readonly SourceAdapter[] = [
  passthroughAdapter,
  awsIpRangesAdapter,
  statuspageAdapter,
];

export function getSourceAdapter(id: SourceAdapterId): SourceAdapter {
  const adapter = sourceAdapters.find(item => item.id === id);
  if (!adapter) throw new Error(`Unknown source adapter: ${id}`);
  return adapter;
}

/** Recommend the strongest-matching adapter for a payload, falling back to passthrough. */
export function recommendAdapter(payload: unknown): SourceAdapter {
  const scores: Array<{ adapter: SourceAdapter; strength: AdapterMatchStrength }> = [];
  for (const adapter of sourceAdapters) {
    if (adapter.id === "passthrough") continue;
    scores.push({ adapter, strength: adapter.detect(payload) });
  }
  const high = scores.find(entry => entry.strength === "high");
  if (high) return high.adapter;
  const low = scores.find(entry => entry.strength === "low");
  if (low) return low.adapter;
  return passthroughAdapter;
}

// ----- helpers -----
function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
function strOr(value: unknown, fallback: string): string {
  if (value == null) return fallback;
  const raw = String(value).trim();
  return raw || fallback;
}
