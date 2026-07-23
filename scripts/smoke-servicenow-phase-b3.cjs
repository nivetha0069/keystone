const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const root = path.resolve(__dirname, "..");
const read = file => fs.readFileSync(path.join(root, "servicenow", file), "utf8");
const context = vm.createContext({
  Class: {
    create() {
      return function ServiceNowClass() {
        if (typeof this.initialize === "function") this.initialize();
      };
    },
  },
  GlideDigest: function GlideDigest() {
    this.getSHA256Hex = value => crypto.createHash("sha256").update(String(value)).digest("hex");
  },
  GlideRecord: function GlideRecord() {
    this.addQuery = function () {};
    this.orderByDesc = function () {};
    this.setLimit = function () {};
    this.query = function () {};
    this.next = function () { return false; };
    this.hasNext = function () { return false; };
  },
  gs: {
    info() {},
    error() {},
    getUserID() { return "55555555555555555555555555555555"; },
    hasRole() { return true; },
    getProperty(_name, fallback) { return fallback; },
  },
  JSON,
  Object,
  Array,
  String,
  Error,
  RegExp,
});

for (const file of [
  "DotwalkersAgentEventDetailService.js",
  "DotwalkersFailureStrategyService.js",
  "DotwalkersIrePayloadService.phase-b3.js",
  "DotwalkersIreSimulationService.phase-b3.js",
  "DotwalkersPhaseB3ATests.phase-b3.js",
  "DotwalkersPhaseB3BTests.phase-b3.js",
]) vm.runInContext(read(file), context, { filename: file });

// Rhino's Function#toString omits executable source, while V8 returns it.
// Replace only the two engine-specific stringification checks with stronger
// checks against the actual checked-in production sources.
context.DotwalkersPhaseB3ATests.prototype.testNoLiveActionsInSource = function () {
  const source = read("DotwalkersIreSimulationService.phase-b3.js");
  const simulate = source.slice(source.indexOf("simulate: function"), source.indexOf("recordProposal: function"));
  for (const forbidden of ["createOrUpdateCI", "eventQueue", ".insert()", ".update()", ".approve(", ".execute(", ".verify("]) {
    if (simulate.includes(forbidden)) throw new Error(`simulate contains ${forbidden}`);
  }
};
context.DotwalkersPhaseB3BTests.prototype.testNoLiveActionsInAdapter = function () {
  const adapter = read("ire_simulate.phase-b3.js").replace(/^\s*\/\/.*$/gm, "");
  for (const forbidden of ["GlideRecord", "GlideAggregate", "sn_cmdb", "IdentificationEngine", "identifyCI", "createOrUpdateCI", "DotwalkersIrePayloadService", "eventQueue", ".insert()", ".update()"]) {
    if (adapter.includes(forbidden)) throw new Error(`adapter contains ${forbidden}`);
  }
};

const b3a = new context.DotwalkersPhaseB3ATests().run();
const b3b = new context.DotwalkersPhaseB3BTests().run();
const failures = [...b3a, ...b3b].filter(result => !result.passed);
assert.deepEqual({ passed: b3a.filter(result => result.passed).length, total: b3a.length }, { passed: 23, total: 23 }, failures.map(item => `${item.test}: ${item.message}`).join("\n"));
assert.deepEqual({ passed: b3b.filter(result => result.passed).length, total: b3b.length }, { passed: 41, total: 41 }, failures.map(item => `${item.test}: ${item.message}`).join("\n"));
console.log("ServiceNow Phase B3 smoke checks passed (B3A 23/23; B3B 41/41).");
