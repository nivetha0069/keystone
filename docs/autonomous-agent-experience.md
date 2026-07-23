# Autonomous Agent Experience

This document extends the agentic CMDB PRD on `main`. It does not replace the ServiceNow, IRE, approval, or verification requirements in that PRD.

## Goal

The product should feel like an autonomous migration operations center rather than a recommendation form.

When a run begins:

1. Comprehend reviews the staged estate.
2. Its LLM planner chooses specialist tools.
3. Router, Atlas, Scout, Weaver, and Sentry exchange observations with Mara through the Event Ledger.
4. Safe read-only work continues without user clicks.
5. Mara observes the completed evidence, groups gaps, investigates likely root causes, and chooses the next safe agent handoff.
6. Non-mutating investigation and IRE simulation may continue autonomously.
7. The system asks for human approval only at a real governance boundary.
8. Approved execution goes through ServiceNow IRE and is verified using the execution correlation.
9. The agents re-evaluate the resulting evidence and show whether the outcome improved.

The intended demo arc is:

```text
500 staged CIs
    |
    v
ServiceNow Comprehend LLM planner
    |
    +--> Atlas: class and attribute evidence
    +--> Scout: duplicate and identity evidence
    +--> Weaver: relationship evidence
    +--> Sentry: deterministic confidence gate
    +--> Ledger: persisted outcome
    |
    v
450 cleared | 40 conflicts | 10 missing identifiers
    |
    v
ServiceNow Mara LLM supervisor
    |
    +--> groups repeated gaps
    +--> investigates root causes
    +--> invokes safe specialist tools
    +--> records each observation and handoff
    |
    v
Human approval only at the governed mutation boundary
    |
    v
ServiceNow IRE execution and verification
```

## Runtime Ownership

All model execution belongs in ServiceNow.

```text
DotwalkersMaraAgent
    |
    +--> DotwalkersAgentSupport
    +--> DotwalkersLLMService
    +--> deterministic read and investigation tools
    +--> IRE simulation tool
    +--> DotwalkersLedgerService
```

The frontend must not:

- store or receive model-provider credentials;
- call Nous, OpenAI, Anthropic, or another provider directly;
- run an authoritative agent loop;
- construct executable IRE payloads;
- claim an action completed before ServiceNow recorded it.

ServiceNow Generative AI model routing selects the configured provider and model. A suggested Mara model property is:

```text
x_kest_dotwalkers.llm.mara_model
```

The exact provider remains an implementation detail behind `DotwalkersLLMService`.

## ServiceNow Mara Loop

`DotwalkersMaraAgent` should run after Comprehend reaches a terminal analysis decision point.

Its bounded loop should:

1. Validate the migration run and team ownership.
2. Read run state, staged CI outcomes, findings, review decisions, relationships, and recent ledger evidence.
3. Build compact aggregate context rather than sending complete source rows.
4. Ask the LLM for one structured decision.
5. Validate the requested tool against an allowlist.
6. Execute only safe tools.
7. record the decision, action, observation, and handoff.
8. Repeat until the run is complete, blocked, or requires approval.

Suggested structured planner response:

```json
{
  "observation": "40 records share a missing serial-number pattern.",
  "decision": "Ask Scout to group identity failures before simulation.",
  "action": "group_identity_failures",
  "input": {
    "migration_run_id": "validated server-side"
  },
  "handoff_to": "Scout",
  "approval_required": false
}
```

The Script Include must reject unknown actions, arbitrary table names, browser-supplied payload authority, and any direct CMDB write tool.

## Persisted Activity Contract

The frontend reads Mara through the same run-scoped ServiceNow bridge and Event Ledger used by the other agents. Mara is the supervisor; Router, Atlas, Scout, Weaver, and Sentry are reasoning subagents. Ledger is shared audit memory, and IRE is the governed execution engine rather than another agent.

Recommended actors:

```text
Comprehend
Router
Atlas
Scout
Weaver
Sentry
Ledger
Mara
```

Recommended Mara event details:

```text
Thought: concise decision summary | Action: inspect_failure_group
Observation: 40 records share missing serial_number and source key patterns.
Handoff: Mara -> Scout | Action: group_identity_failures
Approval required: 3 records have ambiguous identity candidates.
Mara completed. 37 records are ready for re-simulation; 3 require review.
```

These are compact, user-facing decision summaries. Full prompts, hidden model scratch work, full model responses, full source rows, credentials, and full IRE payloads must not be stored in Event Ledger detail.

If more structured output is required, the Script Include may use an existing finding record for the durable root-cause summary while retaining compact progress events in the ledger.

## Frontend Behavior

The frontend:

- polls the run-scoped Event Ledger while Agent HR is open;
- resolves generic Comprehend events to specialists using recorded action evidence;
- shows chronological decision, action, observation, result, and handoff cards;
- shows Mara only when actor `Mara` events actually exist;
- derives waiting, working, approval-required, complete, and blocked states from recorded Mara evidence;
- keeps deterministic governance checks separate from LLM-generated explanations;
- displays an honest waiting state when the Mara Script Include has not written events.

No frontend model route or `MARA_LLM_*` Vercel variables are required.

## Autonomy Boundary

Allowed without human approval:

- read staged data;
- classify and normalize;
- inspect attributes and relationships;
- detect duplicates and missing identifiers;
- group failures;
- calculate deterministic priority;
- request non-mutating IRE simulation;
- compare simulation results;
- prepare an approval-ready evidence packet.
- compose frozen 20-record campaign manifests into a bounded parent approval
  packet and explain aggregate risk, exclusions, and samples.

Must pause:

- ambiguous identity;
- low confidence;
- unsupported class or attribute;
- protected-service impact;
- policy exception;
- stale simulation fingerprint;
- any production CMDB mutation.

At scale, pausing does not require one browser confirmation per CI. Milestone
8A may present one human confirmation for an exact parent hash covering 100–200
homogeneous records. That confirmation is a governance action by the user, not
an agent tool. ServiceNow still persists and enforces an individual approval
chain for every included CI, and Phase D remains the only execution owner.

Execution remains identifier-only from the browser. ServiceNow rebuilds the authoritative payload and IRE remains the only CMDB write path.

## Cost Control

Model cost is controlled inside ServiceNow:

- use compact aggregate evidence;
- do not send all 500 raw CI payloads to every planner call;
- choose one tool per bounded iteration;
- use deterministic specialists for scans and counts;
- ask the LLM to plan, explain, group, and hand off;
- cap loop iterations;
- stop on repeated actions;
- cache or reuse stable summaries where appropriate;
- record token usage when ServiceNow's Generative AI response exposes it.

The frontend adds no additional model usage.

## Acceptance Criteria

- Comprehend's real LLM tool choices appear live in sequence.
- Agent HR shows Router, Atlas, Scout, Weaver, Sentry, Ledger, Comprehend, and Mara from persisted evidence.
- Mara model execution occurs only in ServiceNow Script Includes.
- The browser contains no provider key and calls no external LLM endpoint.
- Mara can continue safe investigation without human clicks.
- Every visible action corresponds to a ServiceNow Event Ledger event, finding, deterministic result, or IRE response.
- Missing Mara backend events produce a truthful waiting state.
- Approval is requested only at defined governance boundaries.
- No model, Script Include, or browser route writes directly to CMDB tables.
- Build and lint pass before the branch is committed or pushed.
