import { createHash } from "node:crypto";

type SourceRecord = Record<string, unknown>;

type SourceRelationship = {
  source?: unknown;
  target?: unknown;
  source_relationship_type?: unknown;
  normalized_relationship_type?: unknown;
};

export type MigrationDemoDatasetOptions = {
  namespace: string;
  className?: string;
  count?: number;
  generatedAt?: string;
  teamIdentifier?: string;
};

export type MigrationDemoDataset = {
  dataset: {
    schema_version: "keystone-migration-demo-v1";
    namespace: string;
    generated_at: string;
    source_schema_version: string;
    source_company: string;
    source_company_key: string;
    proposed_class: string;
    staging_only: true;
    disclaimer: string;
  };
  cis: SourceRecord[];
  relationships: Array<{
    source: string;
    target: string;
    source_relationship_type: string;
    normalized_relationship_type: string;
  }>;
};

export type MigrationDemoManifest = {
  schema_version: "keystone-migration-demo-manifest-v1";
  namespace: string;
  generated_at: string;
  proposed_class: string;
  source_sha256: string;
  counts: {
    source_cis: number;
    materialized_cis: number;
    relationships: number;
    unique_source_identifiers: number;
  };
  safety: {
    staging_only: true;
    service_now_simulation_authoritative: true;
    exact_packet_hash_authorization_required: true;
    operation_is_not_predeclared: true;
    namespace_must_not_be_reused_for_fresh_insert_demos: true;
  };
};

export function materializeMigrationDemoDataset(
  source: unknown,
  options: MigrationDemoDatasetOptions,
): { dataset: MigrationDemoDataset; manifest: MigrationDemoManifest } {
  const root = object(source, "Dataset must be a JSON object.");
  const rows = Array.isArray(root.cis) ? root.cis.map((row, index) => object(row, `CI row ${index + 1} must be an object.`)) : [];
  if (!rows.length) throw new Error("Dataset must contain a non-empty cis array.");

  const namespace = demoNamespace(options.namespace);
  const className = proposedClass(options.className || "cmdb_ci_linux_server");
  const generatedAt = isoTimestamp(options.generatedAt || new Date().toISOString());
  const count = options.count === undefined ? rows.length : positiveInteger(options.count, "count");
  if (count > rows.length) throw new Error(`Requested ${count} CIs, but the source contains only ${rows.length}.`);
  if (count > 65_024) throw new Error("A single migration-ready dataset is limited to 65,024 CIs so every row receives a distinct private IPv4 address.");

  const metadata = record(root.dataset);
  const company = text(metadata.company) || "Generated company fixture";
  const companyKey = slug(text(metadata.company_key) || company) || "company";
  const teamIdentifier = text(options.teamIdentifier) || "THE_DOTWALKERS";
  const selected = rows.slice(0, count);
  const firstIdentityMapping = new Map<string, string>();

  const cis = selected.map((row, index) => {
    const ordinal = index + 1;
    const suffix = String(ordinal).padStart(6, "0");
    const id = `ks-${namespace}-${suffix}`;
    const name = `ks-${namespace}-ci-${suffix}`;
    const originalId = sourceIdentity(row);
    if (originalId && !firstIdentityMapping.has(originalId)) firstIdentityMapping.set(originalId, id);
    return {
      id,
      source_identifier: id,
      source_record_id: id,
      source_native_key: id,
      name,
      host_name: name,
      fqdn: `${name}.demo.invalid`,
      className,
      ci_class: className,
      ip_address: privateIp(namespace, ordinal),
      serial_number: `KS-${namespace.toUpperCase()}-${suffix}`,
      manufacturer: "Keystone Demo",
      model: text(row.model) || "Generated CI",
      operating_system: className.includes("linux") ? "Linux" : text(row.operating_system) || "",
      os_version: className.includes("linux") ? text(row.os_version) || "9.0" : text(row.os_version) || "",
      environment: text(row.environment) || "demo",
      owned_by: text(row.owned_by) || "keystone.demo.owner",
      support_group: text(row.support_group) || "Keystone Demo Operations",
      location: text(row.location) || "Demo Lab",
      business_application: text(row.business_application) || `${company} Demo Estate`,
      application_service: text(row.application_service) || `${company} Demo Service`,
      source: `${companyKey}-keystone-demo-${namespace}`,
      team_identifier: teamIdentifier,
      generated_at: generatedAt,
      keystone_demo_namespace: namespace,
      source_original_id: originalId,
      source_original_class: text(row.className) || text(row.ci_class),
    };
  });

  const selectedIds = new Set(cis.map(ci => String(ci.id)));
  const seenRelationships = new Set<string>();
  const relationships = (Array.isArray(root.relationships) ? root.relationships : [])
    .flatMap((value): MigrationDemoDataset["relationships"] => {
      const relationship = record(value) as SourceRelationship;
      const sourceId = firstIdentityMapping.get(text(relationship.source));
      const targetId = firstIdentityMapping.get(text(relationship.target));
      if (!sourceId || !targetId || sourceId === targetId || !selectedIds.has(sourceId) || !selectedIds.has(targetId)) return [];
      const key = `${sourceId}|${targetId}`;
      if (seenRelationships.has(key)) return [];
      seenRelationships.add(key);
      return [{
        source: sourceId,
        target: targetId,
        source_relationship_type: text(relationship.source_relationship_type) || "Depends on",
        normalized_relationship_type: text(relationship.normalized_relationship_type) || "Depends on::Used by",
      }];
    });

  const dataset: MigrationDemoDataset = {
    dataset: {
      schema_version: "keystone-migration-demo-v1",
      namespace,
      generated_at: generatedAt,
      source_schema_version: text(metadata.schema_version),
      source_company: company,
      source_company_key: companyKey,
      proposed_class: className,
      staging_only: true,
      disclaimer: "Synthetic CMDB-shaped demo data. ServiceNow simulation remains authoritative for class acceptance and operation selection.",
    },
    cis,
    relationships,
  };
  const manifest: MigrationDemoManifest = {
    schema_version: "keystone-migration-demo-manifest-v1",
    namespace,
    generated_at: generatedAt,
    proposed_class: className,
    source_sha256: sha256(JSON.stringify(root)),
    counts: {
      source_cis: rows.length,
      materialized_cis: cis.length,
      relationships: relationships.length,
      unique_source_identifiers: new Set(cis.map(ci => ci.source_identifier)).size,
    },
    safety: {
      staging_only: true,
      service_now_simulation_authoritative: true,
      exact_packet_hash_authorization_required: true,
      operation_is_not_predeclared: true,
      namespace_must_not_be_reused_for_fresh_insert_demos: true,
    },
  };
  return { dataset, manifest };
}

function demoNamespace(value: string) {
  const normalized = slug(value);
  if (!/^[a-z0-9][a-z0-9-]{2,39}$/.test(normalized)) {
    throw new Error("namespace must normalize to 3-40 lowercase letters, numbers, or hyphens.");
  }
  return normalized;
}

function proposedClass(value: string) {
  const normalized = value.trim().toLowerCase();
  if (!/^cmdb_ci_[a-z0-9_]{1,80}$/.test(normalized)) {
    throw new Error("className must be a canonical cmdb_ci_* table name. ServiceNow still decides whether it is allowlisted.");
  }
  return normalized;
}

function sourceIdentity(row: SourceRecord) {
  for (const key of ["source_native_key", "source_record_id", "source_identifier", "id", "name", "host_name", "fqdn"]) {
    const value = text(row[key]);
    if (value) return value;
  }
  return "";
}

function privateIp(namespace: string, ordinal: number) {
  const namespaceByte = Number.parseInt(sha256(namespace).slice(0, 2), 16);
  const zeroBased = ordinal - 1;
  return `10.${namespaceByte}.${Math.floor(zeroBased / 254)}.${(zeroBased % 254) + 1}`;
}

function positiveInteger(value: number, name: string) {
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer.`);
  return value;
}

function isoTimestamp(value: string) {
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) throw new Error("generatedAt must be an ISO-compatible timestamp.");
  return parsed.toISOString();
}

function object(value: unknown, message: string): SourceRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(message);
  return value as SourceRecord;
}

function record(value: unknown): SourceRecord {
  return value && typeof value === "object" && !Array.isArray(value) ? value as SourceRecord : {};
}

function text(value: unknown) {
  return value === undefined || value === null ? "" : String(value).trim();
}

function slug(value: string) {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40);
}

function sha256(value: string) {
  return createHash("sha256").update(value).digest("hex");
}
