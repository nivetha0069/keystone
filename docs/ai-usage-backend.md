# AI Usage Backend (`/api/x_kest_dotwalkers/cmdb_bridge/usage`)

Backend artifacts that power the existing frontend `/ai-usage` route and its
`GET /api/cmdb/usage?run=<sys_id>` proxy. The frontend contract is already
implemented (`app/lib/cmdb/usage-adapter.ts`) and is **not changed** here.

Scope: `x_kest_dotwalkers`. No global AI metric tables are queried from the
browser; the browser only ever calls the scoped bridge below.

Source files in this repo (copy into the instance — ServiceNow source is not
managed as XML here):

- `servicenow/DotwalkersAIUsageService.js` — Script Include.
- `servicenow/cmdb_bridge_usage_GET.js` — Scripted REST resource script.
- `servicenow/verify_ai_usage.background.js` — background create/verify script.

---

## 1. Table: `x_kest_dotwalkers_ai_usage`

Justified per `docs/agent-harness.md` ("a separate `agent_trace` table becomes
justified when audit requirements require model IDs, token metrics, latency…").
One row per attempted model call.

### Manual creation steps

1. **All > System Definition > Tables > New** (ensure application scope is
   *The Dotwalkers* / `x_kest_dotwalkers`).
2. Label: `AI Usage`. Name autofills to `x_kest_dotwalkers_ai_usage`.
   Leave "Extends table" empty. Create.
3. Add the columns below (**Table Columns** related list > New for each).

| Label | Column name | Type | Reference / Choices | Max len |
|---|---|---|---|---|
| Migration Run | `migration_run` | Reference | `x_kest_dotwalkers_migration_run` | — |
| Team Prefix | `team_prefix` | String | — | 40 |
| Phase | `phase` | Choice | `Comprehend`, `Mara`, `Prioritize` | 40 |
| Model | `model` | String | — | 100 |
| Input Tokens | `input_tokens` | Integer | — | — |
| Output Tokens | `output_tokens` | Integer | — | — |
| Total Tokens | `total_tokens` | Integer | — | — |
| Duration (ms) | `duration_ms` | Integer | — | — |
| Status | `status` | Choice | `success`, `fallback`, `error` | 40 |
| Fallback Reason | `fallback_reason` | String | — | 500 |
| Provider Request ID | `provider_request_id` | String | — | 100 |
| Created | `created` | Date/Time | — | — |

4. For **Phase** and **Status**, set *Choice field type = Dropdown without
   `-- None --`* and add the choice values exactly as listed (labels can match
   values). Note: the Script Include also tolerates unlisted values defensively.
5. Suggested list/read ACLs: readable by `x_kest_dotwalkers` app users; no
   create/update ACL is needed for the UI — records are written only by the
   server-side Script Include.

`sys_created_on` is used as a tiebreaker order; `created` is the authoritative
timestamp returned by the API.

---

## 2. Script Include: `DotwalkersAIUsageService`

Full source: [`servicenow/DotwalkersAIUsageService.js`](../servicenow/DotwalkersAIUsageService.js).

- **Accessible from:** *This application scope only* (call cross-scope only if a
  future global caller needs it).
- Methods: `recordCall(data)`, `listForRun(runId)`, `summarize(calls)`.

`recordCall` guarantees:

- validates the migration run exists (else logs and returns `null`);
- forces `team_prefix = THE_DOTWALKERS`;
- normalizes every numeric to a non-negative integer (missing/invalid → `0`);
- `total_tokens = max(provided total, input + output)`;
- writes exactly one row per attempted call;
- **never throws** into orchestration — wraps everything in try/catch and logs
  with `gs.error`;
- stores no prompts, responses, credentials, or raw payloads; `fallback_reason`
  is whitespace-collapsed and capped at 500 chars.

---

## 3. Scripted REST resource: `usage` (GET)

Full source: [`servicenow/cmdb_bridge_usage_GET.js`](../servicenow/cmdb_bridge_usage_GET.js).

### Manual creation steps

1. **All > System Web Services > Scripted REST APIs**, open the existing
   **cmdb_bridge** API (scope `x_kest_dotwalkers`).
2. **Resources > New**:
   - Name: `usage`
   - HTTP method: `GET`
   - Relative path: `/usage`
   - Requires authentication: **true** (match the other `cmdb_bridge` resources).
3. Paste the resource script from the file above.
4. Confirm the resource resolves to
   `/api/x_kest_dotwalkers/cmdb_bridge/usage`.

### Contract

`GET /api/x_kest_dotwalkers/cmdb_bridge/usage?run=<sys_id>`

| Condition | Status |
|---|---|
| missing `run` | 400 |
| `run` not found | 404 |
| `run.team_prefix` ≠ `THE_DOTWALKERS` | 403 |
| success (calls may be empty) | 200 |
| unexpected error | 500 |

Calls are ordered by `created` ascending. Never returns credentials, prompts,
responses, hidden reasoning, raw provider payloads, or system properties.

---

## 4. Minimal call-site patches

The instance-side Script Includes are authoritative; apply these **minimal**
edits. Do not alter scoring, orchestration, approvals, IRE, or CMDB writes.

### 4a. `DotwalkersLLMService` — add one private recorder + wrap each method

Add a shared private helper (records usage without changing return values):

```javascript
// Records usage for one model call. Tokens come ONLY from real provider
// metadata; when absent, zeros are written (never estimated).
_recordUsage: function (context, model, resp, durationMs, status, fallbackReason) {
    context = context || {};
    if (!context.migration_run_id) { return; } // backward-compatible: no context => no logging
    var tok = this._extractTokens(resp);
    new x_kest_dotwalkers.DotwalkersAIUsageService().recordCall({
        migration_run_id: context.migration_run_id,
        phase: context.phase,
        model: model,
        input_tokens: tok.input,
        output_tokens: tok.output,
        total_tokens: tok.total,
        duration_ms: durationMs,
        status: status,
        fallback_reason: fallbackReason,
        provider_request_id: tok.requestId
    });
},

// Extract token metadata from the real Generative AI response only.
// Adjust the field paths below to match your provider response shape.
_extractTokens: function (resp) {
    var usage = (resp && (resp.usage || (resp.metadata && resp.metadata.usage))) || {};
    var input  = parseInt(usage.input_tokens  != null ? usage.input_tokens  : usage.prompt_tokens, 10);
    var output = parseInt(usage.output_tokens != null ? usage.output_tokens : usage.completion_tokens, 10);
    var total  = parseInt(usage.total_tokens, 10);
    return {
        input:  isNaN(input)  ? 0 : input,
        output: isNaN(output) ? 0 : output,
        total:  isNaN(total)  ? 0 : total,
        requestId: (resp && (resp.request_id || (resp.metadata && resp.metadata.request_id))) || ''
    };
},
```

Wrap each public method (shown for Comprehend; repeat for Mara/Prioritize with
the matching model property and unchanged provider call):

```javascript
generateForComprehend: function (prompt, context) {
    var model = gs.getProperty('x_kest_dotwalkers.llm.comprehend_model', 'claude-sonnet-4-6');
    var t0 = new GlideDateTime().getNumericValue();
    try {
        var resp = this._invokeModel(prompt, model);          // <-- existing provider call, unchanged
        var dt = new GlideDateTime().getNumericValue() - t0;
        this._recordUsage(context, model, resp, dt, 'success', '');
        return resp;                                          // <-- unchanged return
    } catch (e) {
        var dt2 = new GlideDateTime().getNumericValue() - t0;
        this._recordUsage(context, model, null, dt2, 'error', String(e && e.message ? e.message : e));
        throw e;                                              // <-- preserve existing error behavior
    }
},
```

`generateForMara` → `x_kest_dotwalkers.llm.mara_model`;
`generateForPrioritize` → `x_kest_dotwalkers.llm.prioritize_model`.
When `context` is omitted, `_recordUsage` no-ops → full backward compatibility.

### 4b. Agents — pass run id + exact phase

```javascript
// DotwalkersComprehendAgent
llm.generateForComprehend(prompt, { migration_run_id: runId, phase: 'Comprehend' });

// DotwalkersMaraAgent
llm.generateForMara(prompt, { migration_run_id: runId, phase: 'Mara' });

// DotwalkersPrioritizeAgent
llm.generateForPrioritize(prompt, { migration_run_id: runId, phase: 'Prioritize' });
```

Use each agent's already-validated migration run sys_id as `runId`. No other
agent logic changes.

### 4c. `DotwalkersPrioritizeAgent` — record deterministic fallback

In the existing fallback branch (model unavailable → deterministic priority),
add exactly one usage row. Do not record it as success:

```javascript
new x_kest_dotwalkers.DotwalkersAIUsageService().recordCall({
    migration_run_id: runId,
    phase: 'Prioritize',
    model: gs.getProperty('x_kest_dotwalkers.llm.prioritize_model', 'claude-sonnet-4-6'),
    input_tokens: 0,          // or actual returned values if the provider returned any
    output_tokens: 0,
    duration_ms: fallbackDurationMs,
    status: 'fallback',
    fallback_reason: String(err && err.message ? err.message : 'Deterministic fallback used.')
});
```

If `generateForPrioritize` already threw and logged an `error` row via 4a, keep
only the `fallback` row for the deterministic path and avoid double-recording
the same attempt — record the fallback where the deterministic result is
actually produced.

---

## 5. Background create/verify script

Full source: [`servicenow/verify_ai_usage.background.js`](../servicenow/verify_ai_usage.background.js).
Leave `RUN_SYS_ID` empty to create a fresh run + three synthetic rows, or set it
to verify an existing run read-only. Synthetic rows exercise the pipeline; they
are not a historical backfill.

---

## 6. Expected API response

`GET /api/x_kest_dotwalkers/cmdb_bridge/usage?run=<run>` after the verify script:

```json
{
  "runId": "<run_sys_id>",
  "calls": [
    { "id": "<sys_id>", "timestamp": "2026-07-19 12:00:00", "phase": "Comprehend", "model": "claude-sonnet-4-6", "inputTokens": 100, "outputTokens": 20, "totalTokens": 120, "durationMs": 900, "status": "success" },
    { "id": "<sys_id>", "timestamp": "2026-07-19 12:00:01", "phase": "Mara", "model": "claude-sonnet-4-6", "inputTokens": 250, "outputTokens": 80, "totalTokens": 330, "durationMs": 1400, "status": "success" },
    { "id": "<sys_id>", "timestamp": "2026-07-19 12:00:02", "phase": "Prioritize", "model": "claude-sonnet-4-6", "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "durationMs": 5, "status": "fallback" }
  ],
  "totals": { "callCount": 3, "inputTokens": 350, "outputTokens": 100, "totalTokens": 450, "durationMs": 2305 }
}
```

A run with no captured usage returns:

```json
{
  "runId": "<run_sys_id>",
  "calls": [],
  "totals": { "callCount": 0, "inputTokens": 0, "outputTokens": 0, "totalTokens": 0, "durationMs": 0 },
  "unavailableReason": "No usage records were captured for this run."
}
```

---

## 7. Changed files / ServiceNow records

**Repo files added**

- `docs/ai-usage-backend.md` (this file)
- `servicenow/DotwalkersAIUsageService.js`
- `servicenow/cmdb_bridge_usage_GET.js`
- `servicenow/verify_ai_usage.background.js`

**ServiceNow records to create / modify (in the instance)**

- New table `x_kest_dotwalkers_ai_usage` + 12 columns + Phase/Status choices.
- New Script Include `DotwalkersAIUsageService`.
- New Scripted REST resource `usage` (GET) on the `cmdb_bridge` API.
- Modified Script Include `DotwalkersLLMService` (recorder + method wrappers).
- Modified Script Includes `DotwalkersComprehendAgent`, `DotwalkersMaraAgent`,
  `DotwalkersPrioritizeAgent` (pass run id + phase; record fallback).
- Optional model properties: `x_kest_dotwalkers.llm.comprehend_model`,
  `…mara_model`, `…prioritize_model`.

**Frontend:** unchanged. The existing `/api/cmdb/usage` proxy and
`app/lib/cmdb/usage-adapter.ts` already consume this exact contract.
No pricing or estimated cost is added anywhere.
