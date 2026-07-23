# Keystone Agent Harness

## Current model

The authoritative agent harness runs in ServiceNow, not in the Next.js browser.
Mara supervises bounded migration work while Router, Atlas, Scout, Weaver, and
Sentry provide specialized reasoning and deterministic evidence.

```text
Mara
  +-- Router: next-safe-step routing
  +-- Atlas: class and attribute evidence
  +-- Scout: identity and duplicate evidence
  +-- Weaver: relationship evidence
  +-- Sentry: confidence and policy gates

Ledger: shared audit memory
IRE: governed execution engine
```

Ledger and IRE are supporting services, not reasoning subagents.

## Runtime ownership

ServiceNow Script Includes own:

- model-provider routing and credentials;
- compact prompt construction;
- tool allowlists;
- bounded iteration and retry limits;
- run/team ownership checks;
- deterministic fallback decisions;
- Event Ledger recording;
- authoritative staged-record reads; and
- IRE simulation requests.

The frontend reads persisted, run-scoped evidence. It does not execute an
authoritative agent loop or call a model provider.

## Agent output contract

Agent decisions are proposals until deterministic ServiceNow validation proves
their inputs and policy. Recommended structured output includes:

```json
{
  "observation": "Repeated missing identity pattern detected.",
  "decision": "Group the affected records before simulation.",
  "action": "group_identity_failures",
  "handoff_to": "Scout",
  "approval_required": false
}
```

Every action must:

- use an allowlisted tool;
- accept identifiers rather than arbitrary table names or executable payloads;
- carry run-scoped correlation;
- be bounded and replay-safe;
- preserve compact evidence;
- abstain or stop when confidence or identity is insufficient; and
- remain separate from mutation authority.

## Persistence

Use existing ServiceNow records:

- `finding` for concise findings, recommendations, and root-cause summaries;
- `review_decision` for human or policy review;
- `event_ledger` for compact decision, action, observation, handoff, lifecycle,
  correlation, and outcome evidence; and
- `ai_usage` for sanitized model-call accounting.

Do not store complete prompts, hidden reasoning, full model responses, complete
source rows, credentials, or executable IRE payloads in Event Ledger detail.

## Autonomy boundary

Agents may autonomously:

- inspect and normalize staged data;
- group findings and failures;
- calculate deterministic priority;
- request non-mutating IRE simulation;
- reconcile healthy records that require no mutation;
- prepare bounded approval evidence; and
- explain the next safe action.

With `CMDB_MARA_AUTONOMOUS_COMMIT_ENABLED=true` and the per-run UI toggle, Mara
may also advance healthy, unmatched insertion candidates through exact
server-derived packets and monitor ServiceNow Phase D verification.

Mara must stop for:

- updates to existing CIs;
- ambiguous identity;
- low confidence;
- unsupported class or attribute;
- stale simulation or policy evidence;
- protected-service impact;
- failures or blockers; and
- any scope outside the healthy-insertion autonomy policy.

## Write boundary

No agent receives a direct CMDB write tool. ServiceNow rebuilds authoritative
payloads from staged evidence, IRE remains the only CI mutation path, and Phase
D owns execution and correlated read-back verification.

## Acceptance

- Visible agent activity must correspond to persisted ServiceNow evidence.
- Missing backend events must render as waiting, not fabricated activity.
- Unknown tools, arbitrary tables, payload authority, and repeated unsafe
  actions must be rejected.
- Model/provider secrets must never reach the browser.
- Agent summaries must not be counted as committed outcomes.
- Terminal migration claims require correlated ServiceNow verification or
  successful non-mutating reconciliation.
