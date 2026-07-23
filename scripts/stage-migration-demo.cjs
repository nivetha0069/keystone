const fs = require("node:fs");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
loadEnvFile(path.join(root, ".env.local"));
registerTypeScript();
const { buildStructuredStagingPayloadFromText } = require("../app/lib/cmdb/import-staging.ts");

main().catch(error => {
  console.error(JSON.stringify({ staged: false, error: error instanceof Error ? error.message : String(error) }, null, 2));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const filePath = path.resolve(root, options.file);
  if (!fs.existsSync(filePath)) throw new Error(`Prepared dataset was not found: ${filePath}`);
  const text = fs.readFileSync(filePath, "utf8");
  const parsed = JSON.parse(text);
  if (parsed?.dataset?.schema_version !== "keystone-migration-demo-v1") {
    throw new Error("Only a keystone-migration-demo-v1 prepared dataset may use this staging command.");
  }
  const fileSha256 = sha256(text);
  const namespace = String(parsed.dataset.namespace || "");
  const sourceName = options.sourceName || `${parsed.dataset.source_company_key || "company"}-demo-${namespace}`;
  const runName = options.runName || `DEMO-${namespace.toUpperCase()}-${new Date().toISOString().slice(0, 10).replaceAll("-", "")}`;
  const payload = buildStructuredStagingPayloadFromText(text, "json", sourceName);
  if (!payload || payload.cis.length !== parsed.cis.length) throw new Error("Prepared dataset could not be converted to the structured ServiceNow staging contract.");
  const body = JSON.stringify({
    sourceType: "file",
    sourceName,
    runName,
    sourceFileName: path.basename(filePath),
    format: "json",
    payload,
    target: "staging",
    mode: "quarantine",
    directCmdbWrite: false,
  });
  const bodyBytes = Buffer.byteLength(body);
  if (bodyBytes > 10 * 1024 * 1024) throw new Error(`Structured staging request is ${bodyBytes} bytes and exceeds the 10 MB gateway limit. Materialize a smaller dataset.`);
  const endpoint = importEndpoint(options.base);
  const plan = {
    staged: false,
    authorization_required: true,
    file: filePath,
    file_sha256: fileSha256,
    request_sha256: sha256(body),
    endpoint_origin: new URL(endpoint).origin,
    run_name: runName,
    source_name: sourceName,
    namespace,
    cis: payload.cis.length,
    relationships: payload.relationships.length,
    request_bytes: bodyBytes,
    safety: "This action creates a migration run and quarantined staging records only. It cannot approve or execute IRE.",
  };
  if (!options.confirmSha256) {
    console.log(JSON.stringify(plan, null, 2));
    return;
  }
  if (options.confirmSha256.toLowerCase() !== fileSha256) {
    throw new Error("--confirm-sha256 does not match the exact prepared dataset file.");
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", ...authorizationHeaders() },
    body,
  });
  const responseText = await response.text();
  let result;
  try { result = responseText ? JSON.parse(responseText) : {}; }
  catch { result = { raw: responseText.slice(0, 1000) }; }
  if (!response.ok) throw new Error(`ServiceNow import returned HTTP ${response.status}: ${responseText.slice(0, 800)}`);
  console.log(JSON.stringify({ ...plan, staged: true, authorization_required: false, service_now: result }, null, 2));
}

function parseArgs(args) {
  const value = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const file = value("--file");
  if (!file) throw new Error("--file is required.");
  return {
    file,
    runName: value("--run-name"),
    sourceName: value("--source-name"),
    base: value("--base"),
    confirmSha256: value("--confirm-sha256"),
  };
}

function importEndpoint(explicit) {
  const candidate = explicit || process.env.CMDB_IMPORT_URL || (process.env.CMDB_API_BASE_URL ? `${process.env.CMDB_API_BASE_URL.replace(/\/$/, "")}/import` : "");
  if (!candidate) throw new Error("CMDB_IMPORT_URL or CMDB_API_BASE_URL is required.");
  const url = new URL(candidate);
  const loopback = ["127.0.0.1", "localhost", "::1", "[::1]"].includes(url.hostname.toLowerCase());
  if (url.protocol !== "https:" && !loopback) throw new Error("The ServiceNow import endpoint must use HTTPS unless it is loopback.");
  return url.toString();
}

function authorizationHeaders() {
  if (process.env.CMDB_API_TOKEN) return { authorization: `Bearer ${process.env.CMDB_API_TOKEN}` };
  if (process.env.CMDB_API_USERNAME && process.env.CMDB_API_PASSWORD) {
    return { authorization: `Basic ${Buffer.from(`${process.env.CMDB_API_USERNAME}:${process.env.CMDB_API_PASSWORD}`).toString("base64")}` };
  }
  return {};
}

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  for (const line of fs.readFileSync(filePath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!match || process.env[match[1]] !== undefined) continue;
    let value = match[2].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
    process.env[match[1]] = value;
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function registerTypeScript() {
  const originalResolve = Module._resolveFilename;
  Module._resolveFilename = function resolveTypeScript(request, parent, isMain, options) {
    if ((request.startsWith("./") || request.startsWith("../")) && parent?.filename) {
      const candidate = path.resolve(path.dirname(parent.filename), request);
      if (!path.extname(candidate) && fs.existsSync(`${candidate}.ts`)) return `${candidate}.ts`;
    }
    return originalResolve.call(this, request, parent, isMain, options);
  };
  require.extensions[".ts"] = function loadTypeScript(module, filename) {
    const output = ts.transpileModule(fs.readFileSync(filename, "utf8"), {
      compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
      fileName: filename,
    }).outputText;
    module._compile(output, filename);
  };
}
