import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const DEFAULT_OUTPUT = "outputs/company-stress-fixtures";
const TIER_CONFIG = {
  smoke: { cis: 100, relationships: 160, uploadIntended: true },
  workflow: { cis: 500, relationships: 900, uploadIntended: true },
  pdi: { cis: 2000, relationships: 4200, uploadIntended: true },
  local: { cis: 10000, relationships: 25000, uploadIntended: false },
  soak: { cis: 50000, relationships: 125000, uploadIntended: false },
};

const MUTATIONS = [
  { code: "clean", start: 0, end: 50, gate: "auto", finding: "none", operation: "INSERT_OR_UPDATE" },
  { code: "duplicate_exact", start: 50, end: 60, gate: "auto", finding: "duplicate", operation: "NO_CHANGE" },
  { code: "missing_identifier", start: 60, end: 68, gate: "review", finding: "missing_attribute", operation: "NO_IRE" },
  { code: "malformed_network", start: 68, end: 74, gate: "error", finding: "data_quality", operation: "NO_IRE" },
  { code: "orphan_parent", start: 74, end: 80, gate: "review", finding: "orphan_rel", operation: "NO_IRE" },
  { code: "field_alias", start: 80, end: 90, gate: "auto", finding: "data_quality", operation: "INSERT_OR_UPDATE" },
  { code: "class_alias", start: 90, end: 95, gate: "auto", finding: "class_mismatch", operation: "INSERT_OR_UPDATE" },
  { code: "missing_required", start: 95, end: 100, gate: "review", finding: "missing_attribute", operation: "INSERT_AS_INCOMPLETE" },
];

const PROFILES = {
  microsoft: {
    company: "Microsoft",
    sourceBasis: ["Microsoft 365 endpoints", "Azure Service Tags"],
    description: "Modern service, endpoint, application, and network estate modeled from Microsoft public service metadata.",
    classAlias: "Linux Srv",
    alias(record) {
      record.svc_area = record.service_area;
      record.network_blocks = record.network_block;
      delete record.service_area;
      delete record.network_block;
    },
    build(index, rng) {
      const product = ["exchange", "sharepoint", "teams", "identity"][index % 4];
      const region = ["us-east", "us-west", "eu-north", "ap-south"][Math.floor(index / 4) % 4];
      const id = `msft-${product}-${pad(index + 1)}`;
      return commonRecord({
        id,
        name: `${product}-${region}-${pad(index + 1)}`,
        className: index % 5 === 0 ? "cmdb_ci_ip_network" : index % 3 === 0 ? "cmdb_ci_appl" : "cmdb_ci_linux_server",
        index,
        rng,
        source: "microsoft-public-services",
        application: title(product),
        service: `${title(product)} Online`,
        supportGroup: "Modern Workplace Support",
        extra: {
          service_area: title(product),
          region,
          endpoint_category: index % 2 ? "Optimize" : "Allow",
          network_block: cidr(index, 40),
          tcp_ports: index % 3 ? "443" : "80,443",
          change_version: `v${1 + Math.floor(index / 100)}`,
        },
      });
    },
  },
  ibm: {
    company: "IBM",
    sourceBasis: ["IMS hierarchy examples", "Db2 SAMPLE structural patterns"],
    description: "Legacy hierarchical and relational estate modeled from IBM IMS and Db2 public samples.",
    classAlias: "Linux Srv",
    alias(record) {
      record.srv_nm = record.host_name;
      record.os_typ = record.operating_system;
      record.mem = record.memory_mb;
      delete record.host_name;
      delete record.operating_system;
      delete record.memory_mb;
    },
    build(index, rng) {
      const layer = ["system", "lpar", "db2-subsystem", "database", "application"][index % 5];
      const id = `ibm-${layer}-${pad(index + 1)}`;
      const parentIndex = index - 1;
      return commonRecord({
        id,
        name: `${layer}-prod-${pad(index + 1)}`,
        className: layer === "database" ? "cmdb_ci_database" : layer === "application" ? "cmdb_ci_appl" : "cmdb_ci_linux_server",
        index,
        rng,
        source: "ibm-legacy-model",
        application: "Core Banking",
        service: "Legacy Transaction Processing",
        supportGroup: layer === "database" ? "Database Support" : "Mainframe Platform Support",
        extra: {
          segment_type: layer.toUpperCase().replaceAll("-", "_"),
          hierarchy_path: `SYSTEM/LPAR/DB2SUB/DB/APP/${pad(index + 1)}`,
          parent: parentIndex >= 0 ? `ibm-${["system", "lpar", "db2-subsystem", "database", "application"][parentIndex % 5]}-${pad(parentIndex + 1)}` : "",
          database_name: `DB${pad(Math.floor(index / 5) + 1, 5)}`,
          memory_mb: 8192 * (1 + (index % 8)),
          legacy_key: `SYS${pad(Math.floor(index / 100) + 1, 3)}-${pad(index + 1)}`,
        },
      });
    },
  },
  cloudflare: {
    company: "Cloudflare",
    sourceBasis: ["Cloudflare public IP ranges", "Radar-shaped BGP observations"],
    description: "Network, ASN, route, and edge-service estate modeled from Cloudflare public operational structures.",
    classAlias: "IP Network",
    alias(record) {
      record.cidr_block = record.network_block;
      record.edge_loc = record.location;
      delete record.network_block;
      delete record.location;
    },
    build(index, rng) {
      const colo = ["phoenix", "seattle", "amsterdam", "singapore", "sydney"][index % 5];
      const id = `cf-edge-${colo}-${pad(index + 1)}`;
      return commonRecord({
        id,
        name: `edge-${colo}-${pad(index + 1)}`,
        className: index % 4 === 0 ? "cmdb_ci_ip_network" : "cmdb_ci_linux_server",
        index,
        rng,
        source: "cloudflare-network-model",
        application: "Edge Network",
        service: "Global Delivery Network",
        supportGroup: "Network Operations",
        extra: {
          asn: `AS${13335 + (index % 50)}`,
          network_block: cidr(index, 104),
          route_origin: `AS${13335 + (index % 50)}`,
          location: title(colo),
          observed_status: index % 17 === 0 ? "degraded" : "healthy",
          observed_at: timestamp(index),
        },
      });
    },
  },
  fastly: {
    company: "Fastly",
    sourceBasis: ["Fastly public status component and incident structures"],
    description: "Application-service and status-component estate modeled from a public Statuspage-style feed.",
    classAlias: "Application Svc",
    alias(record) {
      record.svc_component = record.application_service;
      record.health_state = record.component_status;
      delete record.application_service;
      delete record.component_status;
    },
    build(index, rng) {
      const component = ["api", "cdn", "image-optimizer", "tls", "logging"][index % 5];
      const id = `fastly-${component}-${pad(index + 1)}`;
      return commonRecord({
        id,
        name: `${component}-service-${pad(index + 1)}`,
        className: index % 3 === 0 ? "cmdb_ci_appl" : "cmdb_ci_linux_server",
        index,
        rng,
        source: "fastly-status-model",
        application: title(component),
        service: `${title(component)} Service`,
        supportGroup: "Service Reliability",
        extra: {
          component_id: `component-${pad((index % 200) + 1, 4)}`,
          component_status: index % 23 === 0 ? "degraded_performance" : "operational",
          incident_id: index % 23 === 0 ? `incident-${pad(index + 1, 6)}` : "",
          incident_updated_at: timestamp(index),
        },
      });
    },
  },
};

function parseArgs(argv) {
  const options = { output: DEFAULT_OUTPUT, tiers: ["smoke", "workflow", "pdi", "local"], companies: Object.keys(PROFILES), seed: 20260720 };
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--output") options.output = argv[++index];
    else if (arg === "--tiers") options.tiers = argv[++index].split(",").filter(Boolean);
    else if (arg === "--companies") options.companies = argv[++index].split(",").filter(Boolean);
    else if (arg === "--seed") options.seed = Number(argv[++index]);
    else if (arg === "--include-soak") options.tiers.push("soak");
    else throw new Error(`Unknown argument: ${arg}`);
  }
  for (const tier of options.tiers) if (!TIER_CONFIG[tier]) throw new Error(`Unknown tier: ${tier}`);
  for (const company of options.companies) if (!PROFILES[company]) throw new Error(`Unknown company: ${company}`);
  if (!Number.isInteger(options.seed)) throw new Error("--seed must be an integer");
  return options;
}

function commonRecord({ id, name, className, index, rng, source, application, service, supportGroup, extra }) {
  const host = className === "cmdb_ci_ip_network" ? "" : name;
  return {
    id,
    source_record_id: id,
    source_native_key: id,
    name,
    host_name: host,
    fqdn: host ? `${host}.example.test` : "",
    className,
    ip_address: className === "cmdb_ci_ip_network" ? "" : ip(index),
    serial_number: `KS-${pad(index + 1, 8)}`,
    manufacturer: source.split("-")[0],
    model: `synthetic-${1 + Math.floor(rng() * 8)}`,
    operating_system: className.includes("linux") ? "Linux" : "",
    os_version: className.includes("linux") ? `${8 + (index % 2)}.${index % 10}` : "",
    environment: ["production", "development", "test"][index % 3],
    owned_by: `owner.${index % 25}`,
    support_group: supportGroup,
    location: ["Phoenix", "Seattle", "Amsterdam", "Singapore"][index % 4],
    business_application: application,
    application_service: service,
    source,
    team_identifier: "THE_DOTWALKERS",
    generated_at: "2026-07-20T00:00:00.000Z",
    ...extra,
  };
}

function applyMutation(profile, records, index, mutation) {
  if (mutation.code === "clean") return records[index];
  if (mutation.code === "duplicate_exact") return structuredClone(records[Math.max(0, index - 1)]);

  const record = records[index];
  if (mutation.code === "missing_identifier") {
    for (const key of ["id", "source_record_id", "source_native_key", "source_identifier", "name", "host_name", "fqdn"]) delete record[key];
  } else if (mutation.code === "malformed_network") {
    record.ip_address = `999.999.${index % 255}.999`;
    record.network_block = `${40 + (index % 120)}.${index % 255}.0.0/99`;
  } else if (mutation.code === "orphan_parent") {
    record.parent = `missing-parent-${pad(index + 1)}`;
  } else if (mutation.code === "field_alias") {
    profile.alias(record);
  } else if (mutation.code === "class_alias") {
    record.className = profile.classAlias;
  } else if (mutation.code === "missing_required") {
    delete record.serial_number;
    delete record.support_group;
    delete record.owned_by;
    delete record.fqdn;
  }
  return record;
}

function generateDataset(companyKey, tier, baseSeed) {
  const profile = PROFILES[companyKey];
  const config = TIER_CONFIG[tier];
  const seed = hashSeed(`${baseSeed}:${companyKey}:${tier}`);
  const rng = mulberry32(seed);
  const records = Array.from({ length: config.cis }, (_, index) => profile.build(index, rng));
  const truth = [];
  const mutationCounts = Object.fromEntries(MUTATIONS.map(mutation => [mutation.code, 0]));

  for (let index = 0; index < records.length; index++) {
    const bucket = index % 100;
    const mutation = MUTATIONS.find(item => bucket >= item.start && bucket < item.end);
    applyMutation(profile, records, index, mutation);
    mutationCounts[mutation.code]++;
    truth.push({
      ordinal: index + 1,
      record_reference: records[index].id || `row-${index + 1}`,
      mutation: mutation.code,
      expected_gate: mutation.gate,
      expected_finding: mutation.finding,
      expected_ire_operation: mutation.operation,
    });
  }

  const validIds = [...new Set(records.map(record => record.id).filter(Boolean))];
  const relationships = generateRelationships(validIds, config.relationships, rng);
  const dataset = {
    dataset: {
      schema_version: "keystone-company-stress-v1",
      company: profile.company,
      company_key: companyKey,
      tier,
      seed,
      generated: true,
      source_basis: profile.sourceBasis,
      description: profile.description,
      disclaimer: "Synthetic CMDB-shaped test data modeled from public structures. This is not the company's private infrastructure inventory.",
    },
    cis: records,
    relationships,
  };

  return { dataset, truth, mutationCounts, seed, config };
}

function generateRelationships(ids, targetCount, rng) {
  const relationships = [];
  const seen = new Set();
  if (ids.length < 2) return relationships;
  let attempts = 0;
  while (relationships.length < targetCount && attempts < targetCount * 20) {
    attempts++;
    const source = ids[Math.floor(rng() * ids.length)];
    const target = ids[Math.floor(rng() * ids.length)];
    if (!source || !target || source === target) continue;
    const key = `${source}|${target}`;
    if (seen.has(key)) continue;
    seen.add(key);
    relationships.push({
      source,
      target,
      source_relationship_type: relationships.length % 5 === 0 ? "Runs on" : "Depends on",
      normalized_relationship_type: "Depends on::Used by",
    });
  }
  if (relationships.length !== targetCount) throw new Error(`Unable to generate ${targetCount} unique relationships from ${ids.length} identifiers`);
  return relationships;
}

async function writeDataset(outputRoot, companyKey, tier, generated) {
  const companyDir = path.join(outputRoot, companyKey);
  await mkdir(companyDir, { recursive: true });
  const dataName = `${companyKey}-${tier}.json`;
  const truthName = `${companyKey}-${tier}.expected.json`;
  const dataPath = path.join(companyDir, dataName);
  const truthPath = path.join(companyDir, truthName);
  const dataText = `${JSON.stringify(generated.dataset, null, 2)}\n`;
  const dataBytes = Buffer.byteLength(dataText);
  const estimatedGatewayBytes = Math.ceil(dataBytes * 3.2);
  const gatewayLimit = 10 * 1024 * 1024;
  const uploadSafe = generated.config.uploadIntended && estimatedGatewayBytes < gatewayLimit;
  const expected = {
    schema_version: "keystone-company-stress-expected-v1",
    company: generated.dataset.dataset.company,
    company_key: companyKey,
    tier,
    seed: generated.seed,
    counts: {
      cis: generated.dataset.cis.length,
      unique_source_identifiers: new Set(generated.dataset.cis.map(record => record.id).filter(Boolean)).size,
      relationships: generated.dataset.relationships.length,
      mutations: generated.mutationCounts,
      gates: summarizeBy(generated.truth, "expected_gate"),
      findings: summarizeBy(generated.truth, "expected_finding"),
      ire_operations: summarizeBy(generated.truth, "expected_ire_operation"),
    },
    safety: {
      upload_intended: generated.config.uploadIntended,
      upload_safe_estimate: uploadSafe,
      source_file_bytes: dataBytes,
      estimated_gateway_body_bytes: estimatedGatewayBytes,
      gateway_limit_bytes: gatewayLimit,
      execute_policy: "Single-record execution only with explicit confirmation. Never batch execute this fixture.",
    },
    records: generated.truth,
  };
  const truthText = `${JSON.stringify(expected, null, 2)}\n`;
  await writeFile(dataPath, dataText, "utf8");
  await writeFile(truthPath, truthText, "utf8");
  await validateWrittenFiles(dataPath, truthPath, generated.dataset.dataset.company);
  return {
    company: generated.dataset.dataset.company,
    company_key: companyKey,
    tier,
    data_file: path.relative(outputRoot, dataPath).replaceAll("\\", "/"),
    expected_file: path.relative(outputRoot, truthPath).replaceAll("\\", "/"),
    cis: generated.dataset.cis.length,
    relationships: generated.dataset.relationships.length,
    source_file_bytes: dataBytes,
    estimated_gateway_body_bytes: estimatedGatewayBytes,
    upload_intended: generated.config.uploadIntended,
    upload_safe_estimate: uploadSafe,
    sha256: sha256(dataText),
  };
}

async function validateWrittenFiles(dataPath, truthPath, expectedCompany) {
  const data = JSON.parse(await readFile(dataPath, "utf8"));
  const truth = JSON.parse(await readFile(truthPath, "utf8"));
  if (data.dataset.company !== expectedCompany || truth.company !== expectedCompany) throw new Error(`Company mismatch in ${dataPath}`);
  if (!Array.isArray(data.cis) || !Array.isArray(data.relationships)) throw new Error(`Invalid staging shape in ${dataPath}`);
  if (truth.counts.cis !== data.cis.length || truth.counts.relationships !== data.relationships.length) throw new Error(`Count mismatch in ${dataPath}`);
  if (truth.records.length !== data.cis.length) throw new Error(`Golden truth row mismatch in ${truthPath}`);
  const validIds = new Set(data.cis.map(record => record.id).filter(Boolean));
  for (const relationship of data.relationships) {
    if (!validIds.has(relationship.source) || !validIds.has(relationship.target)) throw new Error(`Broken relationship endpoint in ${dataPath}`);
  }
}

function summarizeBy(rows, key) {
  return rows.reduce((counts, row) => {
    counts[row[key]] = (counts[row[key]] || 0) + 1;
    return counts;
  }, {});
}

function mulberry32(seed) {
  return function random() {
    let value = seed += 0x6D2B79F5;
    value = Math.imul(value ^ value >>> 15, value | 1);
    value ^= value + Math.imul(value ^ value >>> 7, value | 61);
    return ((value ^ value >>> 14) >>> 0) / 4294967296;
  };
}

function hashSeed(value) {
  return Number.parseInt(createHash("sha256").update(value).digest("hex").slice(0, 8), 16);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function pad(value, length = 6) {
  return String(value).padStart(length, "0");
}

function title(value) {
  return value.split("-").map(part => `${part.charAt(0).toUpperCase()}${part.slice(1)}`).join(" ");
}

function ip(index) {
  return `10.${Math.floor(index / 65025) % 250}.${Math.floor(index / 255) % 255}.${(index % 254) + 1}`;
}

function cidr(index, firstOctet) {
  return `${firstOctet + (Math.floor(index / 65536) % 40)}.${Math.floor(index / 256) % 256}.${index % 256}.0/24`;
}

function timestamp(index) {
  const minute = index % (24 * 60);
  return `2026-07-${pad(1 + (Math.floor(index / (24 * 60)) % 19), 2)}T${pad(Math.floor(minute / 60), 2)}:${pad(minute % 60, 2)}:00.000Z`;
}

function csvCell(value) {
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

const options = parseArgs(process.argv.slice(2));
const outputRoot = path.resolve(options.output);
await mkdir(outputRoot, { recursive: true });
const catalog = [];

for (const companyKey of options.companies) {
  for (const tier of [...new Set(options.tiers)]) {
    const generated = generateDataset(companyKey, tier, options.seed);
    catalog.push(await writeDataset(outputRoot, companyKey, tier, generated));
  }
}

const catalogJson = {
  schema_version: "keystone-company-stress-catalog-v1",
  generated_at: "2026-07-20T00:00:00.000Z",
  generator_seed: options.seed,
  companies: options.companies,
  tiers: [...new Set(options.tiers)],
  files: catalog,
};
await writeFile(path.join(outputRoot, "catalog.json"), `${JSON.stringify(catalogJson, null, 2)}\n`, "utf8");
const csvRows = [
  ["company", "company_key", "tier", "cis", "relationships", "source_file_bytes", "estimated_gateway_body_bytes", "upload_intended", "upload_safe_estimate", "data_file", "expected_file", "sha256"],
  ...catalog.map(row => [row.company, row.company_key, row.tier, row.cis, row.relationships, row.source_file_bytes, row.estimated_gateway_body_bytes, row.upload_intended, row.upload_safe_estimate, row.data_file, row.expected_file, row.sha256]),
];
await writeFile(path.join(outputRoot, "catalog.csv"), `${csvRows.map(row => row.map(csvCell).join(",")).join("\n")}\n`, "utf8");

console.log(JSON.stringify({ output: outputRoot, files: catalog.length * 2 + 2, catalog }, null, 2));
