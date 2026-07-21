import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

const DEFAULT_SCOPE = "x_kest_dotwalkers";
const DEFAULT_LIMIT = 100;
const MAX_PAGES = 100;

const COMMON_FIELDS = [
  "sys_id", "name", "sys_name", "active", "sys_class_name", "sys_scope",
  "sys_package", "sys_update_name", "sys_created_on", "sys_created_by",
  "sys_updated_on", "sys_updated_by", "description", "short_description",
];

const ARTIFACTS = [
  artifact("application-metadata", "sys_metadata", [], ["sys_class_name", "sys_name", "sys_update_name"]),
  artifact("script-includes", "sys_script_include", ["script"], ["api_name", "access", "client_callable"]),
  artifact("scripted-rest-apis", "sys_ws_definition", [], ["base_uri", "namespace", "service_id"]),
  artifact("scripted-rest-resources", "sys_ws_operation", ["operation_script"], [
    "web_service_definition", "http_method", "operation_uri", "relative_path",
    "requires_authentication", "requires_acl_authorization", "enforce_acl",
  ]),
  artifact("business-rules", "sys_script", ["script"], [
    "collection", "when", "order", "condition", "filter_condition",
    "action_insert", "action_update", "action_delete", "action_query",
  ]),
  artifact("script-actions", "sysevent_script_action", ["script"], ["event_name"]),
  artifact("event-registrations", "sysevent_register", [], ["event_name", "table"]),
  artifact("scheduled-scripts", "sysauto_script", ["script"], [
    "run_type", "run_period", "run_start", "time_zone",
  ]),
  artifact("access-controls", "sys_security_acl", ["script"], [
    "type", "operation", "admin_overrides", "condition",
  ]),
  artifact("ui-actions", "sys_ui_action", ["script"], [
    "table", "action_name", "client", "condition", "onclick", "form_action", "list_action",
  ]),
  artifact("client-scripts", "sys_script_client", ["script"], [
    "table", "type", "ui_type", "isolate_script", "applies_extended",
  ]),
  // Deliberately excludes the `value` field.
  artifact("system-property-metadata", "sys_properties", [], [
    "type", "choices", "ignore_cache", "is_private", "read_roles", "write_roles",
  ]),
];

export function artifact(directory, table, scriptFields, extraFields) {
  return {
    directory,
    table,
    scriptFields,
    fields: [...new Set([...COMMON_FIELDS, ...extraFields, ...scriptFields])],
  };
}

export function parseArgs(argv) {
  const options = {
    scope: DEFAULT_SCOPE,
    envFile: ".env.local",
    outputRoot: path.join("outputs", "servicenow-export"),
    limit: DEFAULT_LIMIT,
  };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--scope") options.scope = requiredValue(argv[++index], arg);
    else if (arg === "--env") options.envFile = requiredValue(argv[++index], arg);
    else if (arg === "--output") options.outputRoot = requiredValue(argv[++index], arg);
    else if (arg === "--limit") options.limit = positiveInteger(requiredValue(argv[++index], arg), arg);
    else if (arg === "--help" || arg === "-h") options.help = true;
    else throw new Error(`Unknown argument: ${arg}`);
  }
  return options;
}

export function sanitizeText(value, knownSecrets = []) {
  let sanitized = String(value ?? "");
  let redactions = 0;
  for (const secret of knownSecrets.filter(item => typeof item === "string" && item.length >= 8)) {
    if (!sanitized.includes(secret)) continue;
    sanitized = sanitized.split(secret).join("[REDACTED_KNOWN_SECRET]");
    redactions++;
  }
  const patterns = [
    /(\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*)(["'])([^"'\r\n]+)\2/gi,
    /(\bAuthorization\b\s*[:=]\s*)(["'])(?:Basic|Bearer)\s+[^"'\r\n]+\2/gi,
    /(https?:\/\/[^\s/:@]+:)[^\s/@]+(@)/gi,
  ];
  for (const pattern of patterns) {
    sanitized = sanitized.replace(pattern, (...match) => {
      redactions++;
      if (pattern === patterns[2]) return `${match[1]}[REDACTED]${match[2]}`;
      return `${match[1]}${match[2]}[REDACTED]${match[2]}`;
    });
  }
  return { value: sanitized, redactions };
}

export async function runExport(options, dependencies = {}) {
  const cwd = dependencies.cwd || process.cwd();
  const env = dependencies.env || await readEnvFile(path.resolve(cwd, options.envFile));
  const fetchImpl = dependencies.fetchImpl || fetch;
  const baseUrl = env.CMDB_API_BASE_URL || env.CMDB_IRE_BASE_URL;
  if (!baseUrl) throw new Error("CMDB_API_BASE_URL or CMDB_IRE_BASE_URL is required");
  const origin = new URL(baseUrl).origin;
  const headers = authorizationHeaders(env);
  const knownSecrets = [env.CMDB_API_PASSWORD, env.CMDB_API_TOKEN];
  const scope = await resolveScope({ origin, headers, fetchImpl, scopeName: options.scope, limit: options.limit });
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputDir = path.resolve(cwd, options.outputRoot, `${slug(options.scope)}-${timestamp}`);
  await fs.mkdir(outputDir, { recursive: true });

  const manifest = {
    schema: "keystone.servicenow-export.v1",
    exported_at: new Date().toISOString(),
    instance: new URL(origin).hostname,
    scope: { sys_id: scope.sys_id, scope: scope.scope, name: scope.name },
    transport: "ServiceNow Table API GET only",
    redaction_policy: "Known credentials and credential-like literals are redacted; system property values are never requested.",
    artifacts: [],
    totals: { records: 0, script_files: 0, redactions: 0, unavailable_tables: 0 },
  };

  for (const definition of ARTIFACTS) {
    const exported = await exportArtifact({
      definition, scope, origin, headers, fetchImpl, outputDir,
      limit: options.limit, knownSecrets,
    });
    manifest.artifacts.push(exported.summary);
    manifest.totals.records += exported.summary.records;
    manifest.totals.script_files += exported.summary.script_files;
    manifest.totals.redactions += exported.summary.redactions;
    if (exported.summary.status !== "exported") manifest.totals.unavailable_tables++;
  }

  await fs.writeFile(path.join(outputDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n", "utf8");
  await assertNoKnownSecrets(outputDir, knownSecrets);
  return { outputDir, manifest };
}

async function exportArtifact(input) {
  const { definition, scope, origin, headers, fetchImpl, outputDir, limit, knownSecrets } = input;
  const directory = path.join(outputDir, definition.directory);
  await fs.mkdir(directory, { recursive: true });
  let records;
  try {
    records = await fetchAll({
      origin,
      headers,
      fetchImpl,
      table: definition.table,
      query: `sys_scope=${scope.sys_id}`,
      fields: definition.fields,
      limit,
    });
  } catch (error) {
    const summary = {
      directory: definition.directory,
      table: definition.table,
      status: "unavailable",
      records: 0,
      script_files: 0,
      redactions: 0,
      error: compactError(error),
    };
    await fs.writeFile(path.join(directory, "index.json"), JSON.stringify({ summary, records: [] }, null, 2) + "\n", "utf8");
    return { summary };
  }

  const normalizedRecords = [];
  let scriptFiles = 0;
  let redactions = 0;
  for (const rawRecord of records) {
    const record = normalizeRecord(rawRecord);
    enforceScope(record, scope, definition.table);
    for (const field of definition.scriptFields) {
      if (typeof record[field] !== "string" || !record[field].trim()) continue;
      const sanitized = sanitizeText(record[field], knownSecrets);
      redactions += sanitized.redactions;
      const extension = field === "operation_script" || field === "script" ? ".js" : ".txt";
      const filename = `${slug(record.name || record.sys_name || definition.table)}-${String(record.sys_id).slice(0, 8)}-${slug(field)}${extension}`;
      await fs.writeFile(path.join(directory, filename), sanitized.value.replace(/\r?\n/g, "\n") + "\n", "utf8");
      record[field] = {
        file: filename,
        bytes: Buffer.byteLength(sanitized.value, "utf8"),
        sha256: sha256(sanitized.value),
        redactions: sanitized.redactions,
      };
      scriptFiles++;
    }
    normalizedRecords.push(sortObject(record));
  }
  normalizedRecords.sort(compareRecords);
  const summary = {
    directory: definition.directory,
    table: definition.table,
    status: "exported",
    records: normalizedRecords.length,
    script_files: scriptFiles,
    redactions,
  };
  if (definition.table === "sys_metadata") summary.class_counts = countBy(normalizedRecords, "sys_class_name");
  await fs.writeFile(path.join(directory, "index.json"), JSON.stringify({ summary, records: normalizedRecords }, null, 2) + "\n", "utf8");
  return { summary };
}

async function resolveScope({ origin, headers, fetchImpl, scopeName, limit }) {
  const scopes = await fetchAll({
    origin,
    headers,
    fetchImpl,
    table: "sys_scope",
    query: `scope=${scopeName}`,
    fields: ["sys_id", "scope", "name", "active"],
    limit,
  });
  const exact = scopes.filter(scope => scalar(scope.scope) === scopeName);
  if (exact.length !== 1) throw new Error(`Expected one sys_scope record for ${scopeName}; found ${exact.length}`);
  return normalizeRecord(exact[0]);
}

async function fetchAll({ origin, headers, fetchImpl, table, query, fields, limit }) {
  const records = [];
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = new URL(`/api/now/table/${encodeURIComponent(table)}`, origin);
    url.searchParams.set("sysparm_query", query);
    url.searchParams.set("sysparm_fields", fields.join(","));
    url.searchParams.set("sysparm_limit", String(limit));
    url.searchParams.set("sysparm_offset", String(page * limit));
    url.searchParams.set("sysparm_display_value", "false");
    url.searchParams.set("sysparm_exclude_reference_link", "true");
    const response = await fetchImpl(url, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(30_000),
    });
    const body = await response.text();
    if (!response.ok) throw new Error(`GET ${table} failed with ${response.status}: ${body.slice(0, 240)}`);
    let parsed;
    try { parsed = body ? JSON.parse(body) : {}; } catch { throw new Error(`GET ${table} returned invalid JSON`); }
    const pageRecords = Array.isArray(parsed.result) ? parsed.result : [];
    records.push(...pageRecords);
    if (pageRecords.length < limit) return records;
  }
  throw new Error(`GET ${table} exceeded ${MAX_PAGES} pages`);
}

function authorizationHeaders(env) {
  if (env.CMDB_API_TOKEN) return { accept: "application/json", authorization: `Bearer ${env.CMDB_API_TOKEN}` };
  if (!env.CMDB_API_USERNAME || !env.CMDB_API_PASSWORD) throw new Error("CMDB_API_USERNAME and CMDB_API_PASSWORD are required when no token is configured");
  return {
    accept: "application/json",
    authorization: `Basic ${Buffer.from(`${env.CMDB_API_USERNAME}:${env.CMDB_API_PASSWORD}`, "utf8").toString("base64")}`,
  };
}

async function readEnvFile(filename) {
  const source = await fs.readFile(filename, "utf8");
  const env = {};
  for (const line of source.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator < 1) continue;
    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    env[key] = value;
  }
  return env;
}

async function assertNoKnownSecrets(directory, secrets) {
  const candidates = secrets.filter(value => typeof value === "string" && value.length >= 8);
  if (!candidates.length) return;
  for (const file of await listFiles(directory)) {
    const content = await fs.readFile(file, "utf8");
    if (candidates.some(secret => content.includes(secret))) throw new Error(`Known credential material remained in export file ${file}`);
  }
}

async function listFiles(directory) {
  const files = [];
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await listFiles(target));
    else files.push(target);
  }
  return files;
}

function normalizeRecord(record) {
  const normalized = {};
  for (const [key, value] of Object.entries(record || {})) normalized[key] = scalar(value);
  return normalized;
}

function scalar(value) {
  if (value && typeof value === "object" && "value" in value) return String(value.value ?? "");
  if (value === null || value === undefined) return "";
  return typeof value === "string" ? value : JSON.stringify(value);
}

function enforceScope(record, scope, table) {
  if (record.sys_scope !== scope.sys_id) throw new Error(`${table} returned an out-of-scope record ${record.sys_id || "unknown"}`);
}

function sortObject(record) {
  return Object.fromEntries(Object.entries(record).sort(([left], [right]) => left.localeCompare(right)));
}

function compareRecords(left, right) {
  return String(left.name || left.sys_name || left.sys_id).localeCompare(String(right.name || right.sys_name || right.sys_id));
}

function countBy(records, field) {
  const counts = {};
  for (const record of records) {
    const key = String(record[field] || "unknown");
    counts[key] = (counts[key] || 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

function sha256(value) {
  return crypto.createHash("sha256").update(value, "utf8").digest("hex");
}

function slug(value) {
  return String(value || "artifact").toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 100) || "artifact";
}

function requiredValue(value, flag) {
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
  return value;
}

function positiveInteger(value, flag) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 1000) throw new Error(`${flag} must be an integer from 1 to 1000`);
  return parsed;
}

function compactError(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/https?:\/\/[^/\s]+/g, "[ServiceNow instance]").slice(0, 500);
}

function printHelp() {
  console.log(`Usage: npm run export:servicenow -- [options]\n\nOptions:\n  --scope <scope>    Application scope (default: ${DEFAULT_SCOPE})\n  --env <file>       Environment file (default: .env.local)\n  --output <dir>     Output root (default: outputs/servicenow-export)\n  --limit <count>    Table API page size (default: ${DEFAULT_LIMIT})\n  --help             Show this help\n\nThe exporter performs ServiceNow Table API GET requests only.`);
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href;
if (invokedDirectly) {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
  } else {
    runExport(options).then(({ outputDir, manifest }) => {
      console.log(JSON.stringify({ output: outputDir, scope: manifest.scope, totals: manifest.totals, artifacts: manifest.artifacts }, null, 2));
    }).catch(error => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    });
  }
}
