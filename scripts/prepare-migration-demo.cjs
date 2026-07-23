const fs = require("node:fs");
const fsp = require("node:fs/promises");
const Module = require("node:module");
const path = require("node:path");
const ts = require("typescript");
const { createHash } = require("node:crypto");

const root = path.resolve(__dirname, "..");
registerTypeScript();
const { materializeMigrationDemoDataset } = require("../app/lib/cmdb/migration-demo-dataset.ts");

main().catch(error => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(root, options.input);
  if (!fs.existsSync(inputPath)) throw new Error(`Input dataset was not found: ${inputPath}`);
  const source = JSON.parse(await fsp.readFile(inputPath, "utf8"));
  const prepared = materializeMigrationDemoDataset(source, {
    namespace: options.namespace,
    className: options.className,
    count: options.count,
    generatedAt: options.generatedAt,
  });
  const outputPath = path.resolve(root, options.output || defaultOutput(options.input, prepared.manifest.namespace));
  const manifestPath = outputPath.replace(/\.json$/i, ".manifest.json");
  for (const target of [outputPath, manifestPath]) {
    if (fs.existsSync(target) && !options.overwrite) throw new Error(`${target} already exists. Choose a new namespace or pass --overwrite explicitly.`);
  }
  await fsp.mkdir(path.dirname(outputPath), { recursive: true });
  const datasetText = `${JSON.stringify(prepared.dataset, null, 2)}\n`;
  const outputSha256 = sha256(datasetText);
  const manifest = {
    ...prepared.manifest,
    data_file: path.relative(root, outputPath).replaceAll("\\", "/"),
    output_sha256: outputSha256,
    output_bytes: Buffer.byteLength(datasetText),
  };
  await fsp.writeFile(outputPath, datasetText, "utf8");
  await fsp.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  console.log(JSON.stringify({
    prepared: true,
    data_file: outputPath,
    manifest_file: manifestPath,
    namespace: manifest.namespace,
    proposed_class: manifest.proposed_class,
    cis: manifest.counts.materialized_cis,
    relationships: manifest.counts.relationships,
    sha256: outputSha256,
    next: `npm.cmd run stage:migration-demo -- --file "${outputPath}"`,
  }, null, 2));
}

function parseArgs(args) {
  const value = name => {
    const index = args.indexOf(name);
    return index >= 0 ? args[index + 1] : undefined;
  };
  const input = value("--input");
  const namespace = value("--namespace");
  if (!input) throw new Error("--input is required.");
  if (!namespace) throw new Error("--namespace is required and must be fresh for every INSERT-oriented demo.");
  const rawCount = value("--count");
  const count = rawCount === undefined ? undefined : Number(rawCount);
  if (rawCount !== undefined && (!Number.isInteger(count) || count < 1)) throw new Error("--count must be a positive integer.");
  return {
    input,
    namespace,
    count,
    className: value("--class") || "cmdb_ci_linux_server",
    generatedAt: value("--generated-at"),
    output: value("--output"),
    overwrite: args.includes("--overwrite"),
  };
}

function defaultOutput(input, namespace) {
  const base = path.basename(input, path.extname(input)).replace(/[^a-zA-Z0-9._-]+/g, "-");
  return path.join("outputs", "servicenow-demo-imports", `${base}-${namespace}.json`);
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
