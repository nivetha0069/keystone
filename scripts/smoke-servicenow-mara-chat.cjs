// Smoke tests for Mara's ServiceNow advisory path.
//
// Runs servicenow/DotwalkersMaraChatService.js and servicenow/mara_chat.advisory.js
// in a vm against stubbed Glide APIs. What is under test is the part that would
// be expensive to get wrong in front of an operator:
//
//   - the service reads and never writes;
//   - a model answer that uses a figure the evidence does not contain is thrown
//     away rather than shown;
//   - a model answer claiming to have acted is thrown away;
//   - an action request is refused before the model is consulted at all;
//   - the resource refuses any mode other than advisory, and refuses a run the
//     caller cannot read.

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

const servicenowDir = path.join(__dirname, "..", "servicenow");

// ---------------------------------------------------------------------------
// Glide stubs
// ---------------------------------------------------------------------------

const RUN_ID = "d5767f732b060b1060aefba6b891bf58";

function makeStore(overrides = {}) {
  const runs = overrides.runs ?? [{
    sys_id: RUN_ID,
    number: "DMR0001034",
    state: "awaiting_approval",
    team_prefix: "THE_DOTWALKERS",
    started: "2026-07-28 06:00:00",
    completed: "",
  }];

  const ci = (identification_status, count) => Array.from({ length: count }, () => ({
    migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", identification_status,
  }));

  return {
    x_kest_dotwalkers_migration_run: runs,
    x_kest_dotwalkers_staged_ci_record: overrides.cis ?? [
      ...ci("new_ci", 7), ...ci("match_found", 2), ...ci("conflict", 3), ...ci("rejected", 1),
    ],
    x_kest_dotwalkers_staged_relationship: overrides.relationships ?? [
      { migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", status: "pending" },
    ],
    x_kest_dotwalkers_finding: overrides.findings ?? [
      { migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", severity: "critical", type: "duplicate" },
      { migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", severity: "high", type: "missing_attribute" },
    ],
    x_kest_dotwalkers_review_decision: overrides.reviews ?? [
      { migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", decision: "deferred" },
      { migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", decision: "approved" },
    ],
    x_kest_dotwalkers_event_ledger: overrides.ledger ?? [
      {
        migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", sequence: 1, actor: "Router",
        event_type: "ingested", detail: "Thought: stage everything | Action: stage_records",
      },
      {
        migration_run: RUN_ID, team_prefix: "THE_DOTWALKERS", sequence: 2, actor: "Mara",
        event_type: "analyzed",
        detail: JSON.stringify({ schema: "keystone.agent.v1", summary: "Prepared an approval packet." }),
      },
    ],
  };
}

/** Every write attempt lands here so the tests can assert there were none. */
function buildContext({ store, canRead = true, llm } = {}) {
  const writes = [];

  function matches(row, queries) {
    return queries.every(([field, value]) => String(row[field] ?? "") === String(value));
  }

  function rowsFor(table) {
    return store[table] ?? [];
  }

  function GlideRecord(table) {
    this.table = table;
    this.queries = [];
    this._rows = [];
    this._index = -1;
    this._limit = Infinity;
    this._current = null;

    this.addQuery = (field, value) => { this.queries.push([field, value]); return { addOrCondition() {} }; };
    this.isValidField = field => rowsFor(table).some(row => field in row) || field === "team_prefix";
    this.setLimit = limit => { this._limit = limit; };
    this.orderBy = field => { this._order = { field, desc: false }; };
    this.orderByDesc = field => { this._order = { field, desc: true }; };
    this.query = () => {
      let rows = rowsFor(table).filter(row => matches(row, this.queries));
      if (this._order) {
        rows = [...rows].sort((a, b) => (this._order.desc ? 1 : -1) * (Number(b[this._order.field] ?? 0) - Number(a[this._order.field] ?? 0)));
      }
      this._rows = rows.slice(0, this._limit);
      this._index = -1;
    };
    this.next = () => {
      this._index += 1;
      this._current = this._rows[this._index] ?? null;
      return this._current !== null;
    };
    this.get = sysId => {
      this._current = rowsFor(table).find(row => row.sys_id === sysId) ?? null;
      return this._current !== null;
    };
    this.getValue = field => (this._current ? String(this._current[field] ?? "") : "");
    this.getUniqueValue = () => (this._current ? String(this._current.sys_id ?? "") : "");
    this.canRead = () => canRead;
    this.initialize = () => { writes.push(["initialize", table]); };
    this.setValue = (field, value) => { writes.push(["setValue", table, field, value]); };
    this.insert = () => { writes.push(["insert", table]); return "written"; };
    this.update = () => { writes.push(["update", table]); return "written"; };
    this.deleteRecord = () => { writes.push(["deleteRecord", table]); return true; };
  }

  function GlideAggregate(table) {
    this.table = table;
    this.queries = [];
    this._groupBy = null;
    this._groups = [];
    this._index = -1;

    this.addQuery = (field, value) => { this.queries.push([field, value]); };
    this.isValidField = field => rowsFor(table).some(row => field in row) || field === "team_prefix";
    this.addAggregate = () => {};
    this.groupBy = field => { this._groupBy = field; };
    this.query = () => {
      const rows = rowsFor(table).filter(row => matches(row, this.queries));
      if (!this._groupBy) {
        this._groups = rows.length ? [{ key: null, count: rows.length }] : [];
      } else {
        const counts = new Map();
        for (const row of rows) {
          const key = String(row[this._groupBy] ?? "unspecified");
          counts.set(key, (counts.get(key) ?? 0) + 1);
        }
        this._groups = [...counts.entries()].map(([key, count]) => ({ key, count }));
      }
      this._index = -1;
    };
    this.next = () => { this._index += 1; return this._index < this._groups.length; };
    this.getValue = () => String(this._groups[this._index]?.key ?? "");
    this.getAggregate = () => String(this._groups[this._index]?.count ?? 0);
  }

  const llmCalls = [];
  function DotwalkersUsageAwareLLMService(runId, phase) {
    this.runId = runId;
    this.phase = phase;
    this.generateForMara = prompt => {
      llmCalls.push(prompt);
      if (!llm) throw new Error("No model configured.");
      return llm(prompt);
    };
  }

  const context = vm.createContext({
    Class: {
      create() {
        return function ServiceNowClass(...args) {
          if (typeof this.initialize === "function") this.initialize(...args);
        };
      },
    },
    gs: { error() {}, info() {}, warn() {}, log() {} },
    GlideRecord,
    GlideAggregate,
    GlideDateTime: function GlideDateTime() {},
    DotwalkersUsageAwareLLMService,
    JSON,
    Array,
    Math,
    String,
    Number,
    parseInt,
    isNaN,
  });

  vm.runInContext(
    fs.readFileSync(path.join(servicenowDir, "DotwalkersMaraChatService.js"), "utf8"),
    context,
    { filename: "DotwalkersMaraChatService.js" },
  );

  return { context, writes, llmCalls };
}

function ask(question, options = {}) {
  const built = buildContext({ store: makeStore(options.store), canRead: options.canRead, llm: options.llm });
  const Service = built.context.DotwalkersMaraChatService;
  const result = new Service(options.runId ?? RUN_ID).answer(question, options.history);
  return { ...built, result };
}

// ---------------------------------------------------------------------------
// 1. Deterministic answers are composed from the run's own counts
// ---------------------------------------------------------------------------
{
  const { result, writes } = ask("Where does the run stand?");
  assert.equal(result.success, true);
  assert.equal(result.decision_source, "deterministic_fallback"); // no model configured
  assert.match(result.answer, /DMR0001034/);
  assert.match(result.answer, /13 staged records/);      // 7 + 2 + 3 + 1
  assert.match(result.answer, /2 findings/);
  assert.match(result.answer, /1 open review decision\b/); // deferred only, and singular
  assert.deepEqual(writes, [], "the advisory path must not write anything");
}

// ---------------------------------------------------------------------------
// 2. Held answer reports identification status, not a guess
// ---------------------------------------------------------------------------
{
  const { result } = ask("Why are records held?");
  assert.equal(result.intent, "held");
  assert.match(result.answer, /3 in identity conflict/);
  assert.match(result.answer, /1 rejected/);
}

// ---------------------------------------------------------------------------
// 3. An action request is refused before the model is consulted
// ---------------------------------------------------------------------------
{
  const { result, llmCalls } = ask("Can you approve it for me?", {
    llm: () => "Sure, I approved all 13 records.",
  });
  assert.equal(result.intent, "action_request");
  assert.equal(result.decision_source, "deterministic");
  assert.match(result.answer, /cannot do that/i);
  assert.match(result.answer, /IRE is the only write path/);
  assert.equal(llmCalls.length, 0, "an action request must never reach the model");
}

// ---------------------------------------------------------------------------
// 4. A grounded model answer is accepted
// ---------------------------------------------------------------------------
{
  const { result } = ask("Where does the run stand?", {
    llm: () => "DMR0001034 is paused for a decision. It holds 13 staged records and 2 findings, with 1 open review decision.",
  });
  assert.equal(result.decision_source, "model");
  assert.match(result.answer, /paused for a decision/);
}

// ---------------------------------------------------------------------------
// 5. A figure the evidence does not contain discards the whole answer
// ---------------------------------------------------------------------------
{
  const { result } = ask("Where does the run stand?", {
    llm: () => "DMR0001034 holds 13 staged records and roughly 47 outstanding issues.",
  });
  assert.equal(result.decision_source, "deterministic_fallback");
  assert.match(result.fallback_reason, /47/);
  assert.ok(!result.answer.includes("47"), "an invented figure must not survive into the answer");
}

// ---------------------------------------------------------------------------
// 6. A claim of having acted discards the answer
// ---------------------------------------------------------------------------
{
  const { result } = ask("What happened most recently?", {
    llm: () => "I approved the outstanding work and the run is moving again.",
  });
  assert.equal(result.decision_source, "deterministic_fallback");
  assert.match(result.fallback_reason, /action this service cannot perform/);
}

// ---------------------------------------------------------------------------
// 7. A sys_id in the answer discards it
// ---------------------------------------------------------------------------
{
  const { result } = ask("Where does the run stand?", {
    llm: () => `The run ${RUN_ID} is paused.`,
  });
  assert.equal(result.decision_source, "deterministic_fallback");
  assert.match(result.fallback_reason, /sys_id/);
}

// ---------------------------------------------------------------------------
// 8. A failing model still produces an answer
// ---------------------------------------------------------------------------
{
  const { result } = ask("Where does the run stand?", {
    llm: () => { throw new Error("Provider timeout"); },
  });
  assert.equal(result.success, true);
  assert.equal(result.decision_source, "deterministic_fallback");
  assert.match(result.answer, /DMR0001034/);
}

// ---------------------------------------------------------------------------
// 9. Run access is enforced
// ---------------------------------------------------------------------------
{
  assert.match(ask("status", { runId: "not-a-sys-id" }).result.error, /sys_id is required/);
  assert.match(ask("status", { runId: "a".repeat(32) }).result.error, /not found/i);
  assert.match(ask("status", { canRead: false }).result.error, /cannot read/i);

  const foreign = ask("status", {
    store: { runs: [{ sys_id: RUN_ID, number: "DMR1", state: "draft", team_prefix: "OTHER_TEAM" }] },
  });
  assert.match(foreign.result.error, /does not belong/i);
}

// ---------------------------------------------------------------------------
// 10. Hidden reasoning never leaves the ledger
// ---------------------------------------------------------------------------
{
  const { result } = ask("What happened most recently?");
  assert.match(result.answer, /Prepared an approval packet/);
  assert.ok(!/Thought:/i.test(result.answer), "agent chain-of-thought must not be surfaced");
  assert.ok(!/schema/i.test(result.answer), "raw event JSON must not be surfaced");
}

// ---------------------------------------------------------------------------
// 11. The resource script: mode, access, and payload shape
// ---------------------------------------------------------------------------
function callResource(body, options = {}) {
  const built = buildContext({ store: makeStore(options.store), canRead: options.canRead, llm: options.llm });
  const sent = {};
  built.context.request = { body: { data: body } };
  built.context.response = {
    setStatus(status) { sent.status = status; },
    setHeader() {},
  };
  const payload = vm.runInContext(
    fs.readFileSync(path.join(servicenowDir, "mara_chat.advisory.js"), "utf8"),
    built.context,
    { filename: "mara_chat.advisory.js" },
  );
  return { status: sent.status, payload, writes: built.writes };
}

{
  const ok = callResource({ migration_run_id: RUN_ID, question: "Where does the run stand?", mode: "advisory" });
  assert.equal(ok.status, 200);
  assert.equal(ok.payload.success, true);
  assert.equal(ok.payload.mode, "advisory");
  assert.equal(ok.payload.run_state, "awaiting_approval");
  assert.ok(ok.payload.evidence.staged_ci_total === 13);
  assert.deepEqual(ok.writes, [], "the resource must not write anything");

  assert.equal(callResource({ question: "hi" }).status, 400);
  assert.equal(callResource({ migration_run_id: RUN_ID, question: "" }).status, 400);

  const wrongMode = callResource({ migration_run_id: RUN_ID, question: "approve it", mode: "execute" });
  assert.equal(wrongMode.status, 400);
  assert.match(wrongMode.payload.error, /answers questions only/);

  const unreadable = callResource({ migration_run_id: RUN_ID, question: "status" }, { canRead: false });
  assert.equal(unreadable.status, 403);

  const missing = callResource({ migration_run_id: "b".repeat(32), question: "status" });
  assert.equal(missing.status, 404);
}

// ---------------------------------------------------------------------------
// 12. Neither file can reach a write path
// ---------------------------------------------------------------------------
{
  for (const file of ["DotwalkersMaraChatService.js", "mara_chat.advisory.js"]) {
    const source = fs.readFileSync(path.join(servicenowDir, file), "utf8");
    const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of ["gs.eventQueue", "cmdb_ci", "cmdb_rel_ci", "IdentificationEngine", ".update(", ".insert(", ".deleteRecord("]) {
      assert.ok(!code.includes(forbidden), `${file} must not contain ${forbidden}`);
    }
  }
}

console.log("PASS: servicenow mara chat (12 groups)");
