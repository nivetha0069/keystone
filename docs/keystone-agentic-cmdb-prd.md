# Keystone Agentic CMDB PRD

## Document Control

**Date:** 2026-07-19  
**Purpose:** Central product requirements document for Keystone's agentic CMDB migration experience.  
**Companion architecture document:** `docs/keystone-technical-stack.md`  
**Non-negotiable rule:** ServiceNow remains authoritative for governed CMDB mutation; Keystone must not write directly to `cmdb_ci*` or `cmdb_rel_ci`.

## 1. Executive Summary

Keystone is an AI-powered CMDB migration operations center for teams moving imperfect source-system data into ServiceNow CMDB safely. It is for CMDB administrators, CMDB architects, migration consultants, data source owners, and governance approvers who need to understand, prepare, simulate, approve, execute, and verify CMDB migration work without relying on record-by-record manual review.

The product is not a generic dashboard, chatbot, ServiceNow Discovery replacement, or direct CMDB writer. The core product value is that Keystone performs meaningful migration work within controlled boundaries: it analyzes source data, normalizes records, identifies findings, groups and prioritizes repeated problems, prepares safe IRE-backed operations, pauses for meaningful approval, executes only through ServiceNow IRE, and verifies the real result.

The web application is central because it is where users observe and direct the work. It should feel like an AI engineering workspace for CMDB migration: an active work queue, visible tool calls, evidence-backed decisions, failure investigation, approval gates, and verification summaries. ServiceNow remains authoritative for persisted migration state, staged records, findings, review decisions, event ledger playback, identity, permissions, IRE payload rebuild, IRE simulation, execution, and verification.

Keystone becomes meaningfully agentic when the system can continue through safe, non-mutating work without constant user clicks, while preserving hard controls around production CMDB changes. The model may reason, summarize, group, and plan, but deterministic services and ServiceNow decide what is valid, authorized, approved, executable, and verified.

## 2. Current-State Assessment

### Implemented Capabilities

- The repository is a Next.js application with a single-page CMDB control surface in `app/cmdb-dashboard.tsx`.
- The application has six primary views: import, comprehend, live, HR, prioritize, and remediate. These views are composed from `app/import-view.tsx`, `app/live-view.tsx`, `app/hr-view.tsx`, `app/agents-data.ts`, and dashboard-local components.
- The app can read ServiceNow bridge resources through compatibility routes in `app/api/cmdb/[resource]/route.ts` for `cis`, `timeline`, `relationships`, and `health`.
- The app can submit import payloads to the ServiceNow bridge through `POST /api/cmdb/import`, preserving the safety posture that imports target staging rather than direct CMDB writes.
- The app can submit remediation proposals through `POST /api/cmdb/remediate`. This is still a proposal path, not an IRE execution path.
- Milestone 4 added a proxy route in `app/api/cmdb/ire/[action]/route.ts` for `simulate`, `approve`, `execute`, and `verify`.
- The IRE proxy is intentionally identifier-only. It forwards `migration_run_id`, `staged_ci_id`, correlation/idempotency metadata, and action-specific approval or correlation fields. It does not forward final class, operation, target CI, CMDB values, or authoritative IRE payloads.
- Server-side ServiceNow credentials are configured through `.env.example` and described in `README.md`. Credentials remain server-side.
- The CMDB contracts in `app/lib/cmdb/contracts.ts` model migration runs, staged CIs, staged relationships, findings, review decisions, event ledger entries, health, and remediation proposals.
- `app/lib/cmdb/ire.ts` defines TypeScript contracts and preview helpers for the single-record IRE flow. Execution previews are explicitly rejected by validation because the browser must not authorize or submit executable payloads.
- `app/lib/cmdb/import-staging.ts` provides browser-side parsing and preview normalization for CSV and JSON imports.
- `app/lib/cmdb/comprehend-adapter.ts` maps live ServiceNow bridge data into the UI's current CI, relationship, timeline, and health shapes.
- `docs/system-architecture.md`, `docs/servicenow-schema-inventory.md`, `docs/servicenow-field-gap-matrix.md`, `docs/cmdb-bridge-api.md`, `docs/ire-flow.md`, and `docs/agent-harness.md` establish the core architecture and governance boundaries.
- Git history shows recent milestones focused on real ServiceNow-backed event semantics and the single-record IRE proxy contract. The latest reviewed commit before this PRD work is `6a4a562 Add single-record IRE proxy contract`.

### Partial Capabilities

- Comprehend is partially represented by UI adapters, ServiceNow-backed staged outcomes, timeline events, findings, confidence indicators, and provenance views. It is not yet an autonomous Comprehend agent running from this repository.
- Prioritize is partially represented by health/fix data, priority display, relationship and confidence context, and recalculation by reloading ServiceNow-backed data. It is not yet a deterministic prioritization engine plus agent planner.
- Remediate is partially represented by tool cards, proposal submission, IRE route contracts, and the ServiceNow-backed Milestone 4 endpoint design. It is not yet a full single-record simulate/approve/execute/verify UI workflow.
- Live Ops is partially real: `app/live-view.tsx` consumes the real timeline/event ledger data and avoids fake timers. It is still a visualization of events, not an orchestrator.
- Agent HR is a useful narrative and persona surface, but it is static data in `app/agents-data.ts`, not runtime agent telemetry.
- The IRE control loop has frontend proxy contracts and ServiceNow endpoint assumptions, but the main browser workflow has not yet been wired to those new `/api/cmdb/ire/*` routes.
- ServiceNow endpoint deployment was reported externally, but this repository does not contain the ServiceNow update set or automated integration tests proving those endpoint response shapes.

### Mocked Capabilities

- Demo data remains in `app/cmdb-data.ts`, including mock CIs, timeline events, relationships, and health data.
- The dashboard still falls back to mock data when no run is selected or when configured ServiceNow resources are unavailable.
- Agent HR uses static agent personas and claims that can overstate the current runtime implementation if shown without context.
- Some import source presets and demo starters are local UX helpers rather than live source-system integrations.
- The Sankey and graph experiences can use demo fallback data when live run data is unavailable.

### Missing Capabilities

- No provider-neutral agent runtime is implemented.
- No work queue exists as a first-class UI or derived orchestration model.
- No autonomous Comprehend, Prioritize, or Remediation loop exists in this repository.
- No frontend single-record IRE control panel exists for simulation, approval, execution, and verification.
- No automated failure grouping, root-cause investigation, or allowed retry strategy loop exists.
- No batch simulation or relationship promotion flow exists.
- No project-owned unit or integration tests were found outside `node_modules`.
- No local test harness exists for missing config, stale fingerprint, duplicate idempotency, double-click execution, missing approval, or wrong verification correlation.
- No source-controlled ServiceNow scripts or update-set artifacts are present for the new IRE endpoints.
- No durable observability layer exists for detailed agent traces outside compact ServiceNow event ledger metadata.

### Technical Debt

- `npm run test` maps to `npm run build`, so the project has build verification but no real test suite.
- The generic CMDB route in `app/api/cmdb/[resource]/route.ts` contains commented-out legacy URL construction and some rough indentation.
- There are two normalization paths: older bridge normalizers in `app/lib/cmdb/bridge-normalizers.ts` and newer Comprehend adapters in `app/lib/cmdb/comprehend-adapter.ts`. This is manageable now but should be consolidated or clearly scoped.
- ServiceNow bridge limitations documented in `docs/cmdb-bridge-api.md` remain important: simple CSV parsing in the ServiceNow import script, `payload` and `detail` string-size constraints, coarse health, no pagination, and hardcoded team assumptions in some write endpoints.
- The documentation sometimes describes intended agent behavior more strongly than the code currently supports.
- Static Agent HR content can blur the line between demo narrative and implemented autonomy.

### Documentation And Code Discrepancies

- The docs correctly define ServiceNow as authoritative, but the UI still presents some agent-oriented experiences from static and derived data.
- `docs/ire-flow.md` and `docs/cmdb-bridge-api.md` describe the Milestone 4 IRE flow, while `app/cmdb-dashboard.tsx` does not yet expose the complete IRE lifecycle to the user.
- `docs/agent-harness.md` describes a conceptual agent harness boundary. No provider implementation, work queue, or model orchestration is implemented.
- `README.md` describes the app as a neutral unnamed frontend in some places while the product direction is Keystone as an AI-powered operations center.

### Milestone Status

- Milestones 0-1: Mostly complete. Architecture, schema inventory, contracts, IRE design, field-gap analysis, and agent harness design exist. Build and lint are currently clean.
- Milestone 2: Partially complete. Import staging and ServiceNow-backed data views exist, with safe demo fallback. Full production-grade ingestion, pagination, and source fixtures remain incomplete.
- Milestone 3: Partially complete. Comprehend and Live Ops views consume ServiceNow-backed run data and event ledger information. Prioritize is still mostly a health/fix presentation layer rather than a complete hybrid deterministic and agentic prioritization layer.
- Milestone 4: Complete. The fingerprint-bound Phase D continuation is deployed and live-validated; Execute and Verify are server-owned, correlated, and exposed to the browser only as status compatibility routes.
- Milestone 5: Complete. The single-record workbench supports simulation, fingerprint-bound approval, automatic continuation monitoring, blockers, correlations, and verification results.
- Milestone 6: Complete. The deterministic work queue and playback state reconstruct from ServiceNow evidence after refresh.
- Milestone 7: Partially delivered. Phase E adds the first bounded bulk loop: stable homogeneous planning, three-wide simulation, frozen manifests, and sequential individual approvals for campaigns of at most 20 CIs. Broader retry strategies and live campaign acceptance remain open.

## 3. User Personas

### CMDB Administrator

Owns day-to-day CMDB integrity. Needs to know which proposed changes are safe, which require review, and whether execution actually changed the expected CI through IRE.

### CMDB Architect

Owns class model, identification strategy, relationship quality, and governance boundaries. Needs evidence for class choices, identifier strategies, relationship risk, and Service Mapping readiness.

### Migration Consultant

Runs migration projects for customers. Needs fast intake, repeatable staging, issue grouping, a clear demo narrative, and confidence that migration work is auditable.

### Data Source Owner

Understands the source system, column meanings, export quirks, and data ownership. Needs clear feedback about missing identifiers, malformed values, unsupported classes, and source-specific quality issues.

### Approver Or Governance Lead

Approves meaningful CMDB changes. Needs concise evidence, risk context, simulation result, fingerprint freshness, execution scope, and post-execution verification before accepting or rejecting an action.

## 4. User Problems

- Source exports are inconsistent, incomplete, and hard to inspect manually.
- Teams struggle to determine the right CMDB class for records from legacy or ambiguous source systems.
- Missing identifiers, malformed serials, duplicate hostnames, and conflicting IDs repeatedly cause IRE failures.
- Findings arrive as a long list, but users need systemic patterns and prioritized work.
- Users cannot easily tell which records are safe to simulate, which require approval, and which are blocked.
- Manual record-by-record remediation is slow and error-prone.
- Teams lack confidence that an AI recommendation is grounded in source evidence and ServiceNow validation.
- It is difficult to prove what an AI system did, which data it used, who approved it, and what changed in ServiceNow.
- Verification often becomes an afterthought, making it hard to confirm that execution matched the approved intent.

## 5. Product Principles

- ServiceNow is authoritative for persisted migration state, identity, permissions, payload rebuild, IRE calls, approvals, event playback, execution, and verification.
- Agents perform work, not just text generation.
- Human approval is used only at governance boundaries.
- Every agent action is observable and tied to a real event, tool call, deterministic operation, ServiceNow API result, or approved model output.
- Every execution is reproducible and auditable.
- The browser and LLM never submit authoritative IRE payloads.
- Non-mutating work should continue autonomously when it is inside configured policy.
- The product should reduce user decisions, not create more review work.
- `team_prefix` is a partitioning attribute only, never authentication evidence.
- CMDB mutations must go through ServiceNow IRE and never direct writes to `cmdb_ci*` or `cmdb_rel_ci`.
- Schema expansion is a last resort during the hackathon.

## 6. End-to-End User Journey

### Upload And Intake

The user selects an existing migration run or uploads a source dataset through the import view. The browser parses CSV or JSON for preview and sends a staging request to `/api/cmdb/import`. Keystone's server route forwards the request to the configured ServiceNow import bridge with server-side credentials.

Persisted records: `migration_run`, `staged_ci_record`, `staged_relationship`, and `event_ledger`.

Failure paths: invalid file type, oversized upload, malformed CSV/JSON, missing ServiceNow configuration, ServiceNow bridge rejection, or partial staging failure.

### Comprehend

The Comprehend layer inspects source rows, source identity, inferred classes, field quality, duplicate candidates, and relationship clues. Today this appears in the UI through ServiceNow-backed staged data and adapter-derived outcomes. The target behavior is autonomous analysis with compact event ledger playback.

Persisted records: staged CIs, staged relationships, findings, and event ledger entries.

Failure paths: unsupported classes, missing identity, malformed identifiers, unknown attributes, orphan relationships, and conflicting source values.

### Prioritize

Deterministic scoring should calculate hard signals such as severity, identifier completeness, confidence, relationship impact, IRE blocking status, and approval requirement. The Prioritize agent then groups repeated issues, explains ordering, and selects the next safe work.

Persisted records: findings, review decisions where applicable, and event ledger entries.

Failure paths: insufficient evidence, ambiguous grouping, missing risk context, or blocked dependency records.

### Remediate And Simulate

The Remediation layer selects eligible staged CIs, asks ServiceNow to rebuild the authoritative operation, and invokes non-mutating IRE simulation through `/api/cmdb/ire/simulate`. The browser sends identifiers and correlation metadata only.

Persisted records: latest valid simulation event, compact simulation fingerprint, actionable finding, and event ledger entries.

Failure paths: missing approval context, invalid class, disallowed attribute, stale staged data, failed IRE simulation, missing identity, duplicate candidate, or ServiceNow role failure.

### Failure Investigation And Retry

When simulations fail, the Remediation agent groups similar failures and investigates likely root causes. It may select only explicitly allowed alternative strategies, such as using a stronger allowed identifier. It must request deterministic backend rebuild and ServiceNow revalidation before re-simulation.

Persisted records: event ledger entries and updated or related findings. Detailed reasoning should live outside compact ServiceNow event detail unless a schema expansion is explicitly approved.

Failure paths: no allowed retry strategy, low confidence, protected service impact, or repeated failure after retry.

### Approval

When governance approval is required, Keystone presents one actionable finding and its simulation evidence. Approval calls `/api/cmdb/ire/approve`, which must create or update a single related `review_decision` rather than creating duplicate findings for repeated approval requests.

Persisted records: one actionable finding, current review decision, simulation fingerprint, correlation metadata, and event ledger entry.

Failure paths: unauthorized approver, stale simulation, duplicate idempotency key, rejected decision, or insufficient rationale.

### Execution

Execution calls `/api/cmdb/ire/execute` with identifiers and correlation metadata only. ServiceNow reloads the staged record, rebuilds the authoritative payload, revalidates permissions, checks approval, checks the approved simulation fingerprint, enforces idempotency and execution locks, and calls `sn_cmdb.IdentificationEngine.createOrUpdateCI(...)` or the approved enhanced equivalent.

Persisted records: execution event tied to the execution correlation ID and compact result metadata.

Failure paths: missing approval, stale fingerprint, duplicate execution, concurrent execution, ServiceNow IRE error, disallowed class or attribute, or missing role.

### Verification

Verification calls `/api/cmdb/ire/verify` with the execution correlation ID. ServiceNow ties verification to the specific execution, reads back the CI, compares expected and actual class and identifiers, records discrepancies, and returns a verification result.

Persisted records: verification event tied to the execution correlation ID.

Failure paths: wrong execution correlation, missing execution, target CI not found, class mismatch, identifier mismatch, or ambiguous read-back.

## 7. Functional Requirements

### Ingestion And Staging

- `FR-ING-001`: Keystone must accept CSV and JSON source data for staging preview.
- `FR-ING-002`: Keystone must preserve original source values and source provenance.
- `FR-ING-003`: Keystone must route imports to ServiceNow staging and must not write directly to production CMDB tables.
- `FR-ING-004`: Keystone must expose the returned migration run identifier and make the run selectable.
- `FR-ING-005`: Keystone must show partial import failures without discarding successfully staged records.
- `FR-ING-006`: Keystone must clearly distinguish browser preview parsing from authoritative ServiceNow staging.

### Comprehend

- `FR-COM-001`: Keystone must inspect staged records and identify proposed CMDB classes.
- `FR-COM-002`: Keystone must preserve confidence, evidence, and source field provenance for class and field decisions.
- `FR-COM-003`: Keystone must detect missing identifiers, malformed values, duplicates, class mismatches, orphan relationships, and unsupported classes.
- `FR-COM-004`: Keystone must record user-readable lifecycle events for meaningful analysis steps.
- `FR-COM-005`: Comprehend outputs must map into existing `staged_ci_record`, `staged_relationship`, `finding`, and `event_ledger` records.
- `FR-COM-006`: The Comprehend agent must not write directly to production CMDB tables.

### Prioritize

- `FR-PRI-001`: Keystone must calculate deterministic priority signals before agent explanation.
- `FR-PRI-002`: Keystone must group related findings into systemic patterns.
- `FR-PRI-003`: Keystone must identify whether each work item is simulation-ready, blocked, approval-required, or deferred.
- `FR-PRI-004`: Keystone must not let model confidence override deterministic severity or policy.
- `FR-PRI-005`: Keystone must continue using `finding` and `review_decision` unless a concrete schema limitation is proven.

### Remediate

- `FR-REM-001`: Keystone must provide a constrained remediation tool layer for staged CIs and findings.
- `FR-REM-002`: The Remediation agent may request previews, simulation, approval, execution, verification, and event recording.
- `FR-REM-003`: The Remediation agent must never receive a generic CMDB write tool.
- `FR-REM-004`: Retry strategies must be selected only from explicitly allowed alternatives.
- `FR-REM-005`: Low-confidence, ambiguous, protected, or policy-breaking actions must pause for human review.
- `FR-REM-006`: The agent must summarize what changed and what remains unresolved after each verified execution.

### IRE Control Loop

- `FR-IRE-001`: Keystone must support single-staged-CI simulation through `/api/cmdb/ire/simulate`.
- `FR-IRE-002`: Keystone must support approval through `/api/cmdb/ire/approve`.
- `FR-IRE-003`: Keystone must support execution through `/api/cmdb/ire/execute`.
- `FR-IRE-004`: Keystone must support verification through `/api/cmdb/ire/verify`.
- `FR-IRE-005`: Browser execute requests must be identifier-only and must not include final operation, target class, target CI, CMDB values, or authoritative payload.
- `FR-IRE-006`: ServiceNow must rebuild the payload for simulation and execution from authoritative staged data.
- `FR-IRE-007`: ServiceNow must generate a deterministic simulation fingerprint from staged record identity and version metadata, migration run, proposed class, normalized allowed attributes, source identity, and intended operation or result classification.
- `FR-IRE-008`: Execution must reject stale approvals when the rebuilt fingerprint does not match the approved simulation fingerprint.
- `FR-IRE-009`: Simulation, approval, execution, and verification must use correlation and idempotency metadata.
- `FR-IRE-010`: Execution must prevent duplicate or concurrent commits for the same staged CI.
- `FR-IRE-011`: Verification must be tied to the specific execution correlation ID.

### Approval

- `FR-GOV-001`: Approval must apply to one actionable finding and one simulated operation.
- `FR-GOV-002`: Repeated approval requests must not create duplicate findings.
- `FR-GOV-003`: Approval must capture decision, rationale, actor, correlation ID, and simulation fingerprint.
- `FR-GOV-004`: Rejection and deferral must be visible in the work queue and activity playback.

### Verification

- `FR-VER-001`: Verification must read back the resulting CI from ServiceNow.
- `FR-VER-002`: Verification must compare expected and actual class, key identifiers, and operation result.
- `FR-VER-003`: Verification must record discrepancies clearly and attach them to the execution correlation ID.
- `FR-VER-004`: Keystone must not mark work as verified based on an older or unrelated execution.

### Agent Work Queue

- `FR-WQ-001`: Keystone must expose an agent-owned work queue derived from existing records and event ledger entries.
- `FR-WQ-002`: The work queue must show running, queued, completed, failed, blocked, approval-required, and verified items.
- `FR-WQ-003`: The work queue must identify the owning layer or agent for each item.
- `FR-WQ-004`: Safe non-mutating work may progress without user interaction.
- `FR-WQ-005`: Work queue states must be derivable without new ServiceNow fields during the hackathon.

### Activity Playback

- `FR-UI-001`: Keystone must translate event ledger entries into user-readable agent activity.
- `FR-UI-002`: Keystone must distinguish reasoning, tool execution, ServiceNow calls, IRE simulation, approval, execution, verification, retry, failure, and completion.
- `FR-UI-003`: Keystone must not fabricate progress with timers or fake statuses for an active run.
- `FR-UI-004`: Every visible activity must correspond to a real event, deterministic operation, tool call, ServiceNow result, or labeled planned demo fixture.

### Provenance

- `FR-PROV-001`: Keystone must preserve source row, source system, source identity, normalized values, proposed class, and evidence.
- `FR-PROV-002`: Keystone must show enough provenance for an approver to understand why an action is proposed.
- `FR-PROV-003`: Keystone must keep full payload dumps out of compact ServiceNow event detail.

### Error Handling

- `FR-ERR-001`: Keystone must show missing configuration errors without falling into misleading live states.
- `FR-ERR-002`: Keystone must surface ServiceNow bridge errors with action, status, and retry guidance.
- `FR-ERR-003`: Keystone must separate partial data availability from total run failure.
- `FR-ERR-004`: Keystone must make stale fingerprint, duplicate idempotency, missing approval, and wrong verification correlation understandable to users.

### Demo Fallback

- `FR-FBK-001`: Keystone may retain demo fallback for local development and presentations.
- `FR-FBK-002`: Demo fallback must be visually distinguishable from a live ServiceNow run.
- `FR-FBK-003`: Agentic demo events must be backed by real code paths or clearly labeled as fixture-driven.

## 8. Agent Tool Contracts

The agent tool layer should be deterministic, typed, and usable without an agent. Browser UI, scripts, and a future Remediation Agent should call the same tools.

### Read Tools

`getMigrationRun`

- Input authority: migration run identifier supplied by user selection or queue context.
- Output shape: run metadata, state, source label, counts, and access decision.
- Guardrails: ServiceNow validates role and ownership.

`getStagedCi`

- Input authority: migration run identifier and staged CI identifier.
- Output shape: staged CI summary, source identity, proposed class, allowed normalized attributes, current findings, and latest lifecycle state.
- Guardrails: ServiceNow validates run membership and attribute visibility.

`getFindings`

- Input authority: migration run identifier, optional staged CI identifier, filters.
- Output shape: findings, severity, confidence, evidence, review decisions, related staged records.
- Guardrails: no invented findings; derived grouping must reference persisted findings.

`getRelationships`

- Input authority: migration run identifier.
- Output shape: staged and matched relationship graph, endpoint states, risk hints.
- Guardrails: inferred source relationships must not be presented as Service Mapping-discovered runtime dependencies.

`getEligibleWork`

- Input authority: migration run identifier and optional policy profile.
- Output shape: ordered work items with derived state, blockers, suggested next tool, and approval requirement.
- Guardrails: deterministic eligibility rules take precedence over model ranking.

### Preview And Simulation Tools

`buildIreOperationPreview`

- Input authority: staged CI identifier and migration run identifier.
- Output shape: non-authoritative preview of class, identifiers, allowed attributes, blockers, and intended operation classification.
- Guardrails: preview is informational only; it is not executable authority.

`simulateStagedCi`

- Input authority: staged CI identifier, migration run identifier, correlation ID, idempotency key.
- Output shape: simulation status, result classification, candidate match, actionable finding reference, compact fingerprint reference, and event reference.
- Guardrails: ServiceNow rebuilds payload, validates roles/classes/attributes, calls non-mutating IRE, and stores compact metadata.

`inspectSimulationFailure`

- Input authority: simulation correlation ID, staged CI identifier, migration run identifier.
- Output shape: failure category, evidence, related failures, allowed retry options.
- Guardrails: may not invent unsupported retry strategies.

### Approval Tools

`requestApproval`

- Input authority: staged CI identifier, migration run identifier, finding identifier, simulation correlation ID, decision request metadata.
- Output shape: current review decision, approval status, rationale, actor, and event reference.
- Guardrails: one actionable finding; no duplicate findings for repeated approval requests; agent cannot approve its own high-risk action.

`checkApproval`

- Input authority: staged CI identifier, migration run identifier, finding identifier, simulation correlation ID.
- Output shape: approval state, actor, decision timestamp, fingerprint match status.
- Guardrails: ServiceNow is authoritative for review decision.

### Execute And Verify Tools

`executeApprovedCi`

- Input authority: staged CI identifier, migration run identifier, simulation correlation ID, execution correlation ID, idempotency key.
- Output shape: execution status, target CI reference, operation classification, event reference, and next verification action.
- Guardrails: identifier-only request; ServiceNow rebuilds payload, validates approval and fingerprint freshness, enforces idempotency and execution locks, and calls IRE.

`verifyExecutedCi`

- Input authority: staged CI identifier, migration run identifier, execution correlation ID, verification correlation ID, idempotency key.
- Output shape: verification status, matched CI, class check, identifier check, discrepancies, event reference.
- Guardrails: verification must tie to the specific execution correlation ID.

### Event Tool

`recordAgentEvent`

- Input authority: migration run identifier, staged CI or finding reference, compact event type, actor, summary, and correlation ID.
- Output shape: event ledger entry.
- Guardrails: compact metadata only; no full prompts, full payloads, credentials, or large source rows.

## 9. State Model

The work-item lifecycle should be derived from existing records and events rather than new fields.

| State | Derived From |
| --- | --- |
| `queued` | Staged record exists and no analysis event has started. |
| `analyzing` | Recent Comprehend event indicates active analysis. |
| `normalized` | Staged CI has normalized payload and class proposal. |
| `finding_generated` | One or more findings exist for the staged CI. |
| `prioritized` | Finding has deterministic priority metadata or appears in health/fix output. |
| `eligible_for_simulation` | Required identifiers, class, and allowed attributes are present. |
| `simulating` | Simulation event with active correlation exists without terminal result. |
| `simulation_passed` | Latest valid simulation event succeeded and produced a fingerprint. |
| `simulation_failed` | Latest simulation event failed or returned blocking errors. |
| `investigating` | Failure inspection or retry analysis event exists. |
| `awaiting_approval` | Actionable finding exists and no approving review decision exists. |
| `approved` | Current review decision approves the latest valid simulation fingerprint. |
| `executing` | Execution event started for the execution correlation ID. |
| `committed` | Execution event reports IRE commit success. |
| `verifying` | Verification event started for the execution correlation ID. |
| `verified` | Verification event tied to the execution correlation ID succeeded. |
| `blocked` | Latest event or finding indicates no allowed next action. |
| `rejected` | Current review decision is rejected or deferred. |

Milestone 4's single-record lifecycle states remain a subset of this model: `not_simulated`, `simulation_failed`, `simulated_pending_approval`, `approved_for_execution`, `execution_rejected_stale_simulation`, `executing`, `executed_pending_verification`, `verified`, and `verification_failed`.

Authoritative sources:

- Simulation result: latest valid ServiceNow simulation event and compact fingerprint for the staged CI.
- Approval: single actionable finding plus current `review_decision`.
- Execution: ServiceNow IRE execution event tied to an execution correlation ID.
- Verification: ServiceNow read-back result tied to the same execution correlation ID.
- Playback: ordered `event_ledger` entries.

## 10. UX Requirements

The web application should show an active migration workspace, not a collection of static metric cards.

- Active agent: show which layer is currently working, what it is doing, and what tool or ServiceNow endpoint it is using.
- Current task: show the selected staged CI or finding, the next action, blockers, and evidence.
- Queued tasks: show ordered upcoming work with eligibility and approval requirements.
- Completed tasks: show simulation, approval, execution, and verification outcomes.
- Tool usage: show concise tool call names, correlation IDs, and status, with details available on demand.
- IRE simulation: show non-mutating result, candidate match, confidence, blockers, and fingerprint freshness status.
- Failure investigation: group repeated failures and explain the shared cause and allowed retry options.
- Retry: show what changed in the proposed strategy, why it is allowed, and the new simulation result.
- Approval requests: present the actionable finding, source evidence, simulation result, risk level, and decision controls.
- Execution: show that ServiceNow rebuilt and executed the operation through IRE, not through a browser-submitted payload.
- Verification: show the read-back result and whether it matched the approved operation.
- Post-action summary: explain what changed, what remains unresolved, and what the agent will do next.

Visible activity must be grounded. Demo fixtures are acceptable only when clearly separated from live run behavior.

## 11. Trust And Safety Requirements

- ServiceNow must validate authenticated identity, scoped roles, migration-run ownership, staged-record ownership, allowed classes, allowed attributes, approval state, and idempotency.
- `team_prefix` must be used for partitioning and filtering only.
- Credentials must remain server-side and out of browser payloads.
- Authorization headers and secrets must be redacted from logs.
- The integration account should use least-privileged scoped roles.
- Browser execute requests must remain identifier-only.
- ServiceNow must rebuild authoritative payloads for simulation and execution.
- Simulation fingerprints must protect execution freshness.
- Duplicate idempotency keys must return prior results or safe rejections.
- Concurrent execution must be rejected or locked server-side.
- Low-confidence, ambiguous, protected, or policy-breaking operations must require human approval or remain blocked.
- Agents must not approve their own high-risk actions.
- Event ledger entries must support audit and playback without storing full prompts, full model responses, full source rows, full IRE payloads, or credentials.

## 12. Non-Functional Requirements

- Latency: UI interactions should respond immediately with pending states; ServiceNow-backed operations should show progress and correlation IDs.
- Resilience: partial ServiceNow resource failures should degrade visibly without replacing live runs with misleading demo data.
- Traceability: each important step must have a correlation ID and event trail.
- Structured output: agent and deterministic service outputs must use typed fields rather than free-form text as authority.
- Provider fallback: the agent harness should support model-provider substitution without changing the ServiceNow authority boundary.
- Safe retries: retries must be idempotent and bounded by allowed strategies.
- Partial failure handling: batch or queue work must continue safe items while isolating failed or blocked items.
- UI responsiveness: the workbench must remain usable during polling and long-running operations.
- Deterministic recovery: after refresh, Keystone must derive current state from ServiceNow records and events.
- Compatibility: existing `/api/cmdb/*` routes must keep working while the IRE routes are added.

## 13. Success Metrics

- Percent of uploaded records analyzed without user interaction.
- Percent of staged CIs with source provenance preserved.
- Percent of findings grouped into systemic patterns.
- Percent of staged CIs automatically classified with acceptable confidence.
- Percent of records marked simulation-ready automatically.
- Percent of simulation failures grouped by shared cause.
- Percent of simulation failures autonomously investigated.
- Percent of failures resolved by an allowed retry strategy.
- Number of human interruptions per migration run.
- Percent of approved operations successfully verified.
- Reduction in manual record-by-record review.
- Time from upload to approval-ready remediation plan.
- Time from approval to verified execution.
- Percent of visible activity backed by event ledger entries or tool results.

## 14. Scope

### Hackathon Must-Have

- Wire the UI to the Milestone 4 single-record IRE endpoints.
- Add a selected-staged-CI IRE panel for simulate, approve, execute, and verify.
- Keep execute requests identifier-only.
- Show fingerprint freshness, approval state, execution correlation, and verification state.
- Derive a compact work queue from current staged records, findings, review decisions, and event ledger entries.
- Add deterministic grouping for at least one repeated failure pattern.
- Present an agent-like remediation loop driven by real endpoint calls and event ledger playback.
- Use a realistic fixture or live run that includes duplicates, missing identifiers, malformed values, and at least one failed simulation.
- Retain ServiceNow as the authority for validation, payload rebuild, IRE calls, and verification.
- Run build and lint before the demo branch is merged.

### Hackathon Stretch

- Add an actual provider-neutral model adapter for summaries or failure explanations.
- Add batch simulation for eligible records while preserving single-record execution approval.
- Add a retry strategy selector for explicitly allowed identifier alternatives.
- Add richer relationship risk and Service Mapping readiness warnings.
- Add route-level tests for IRE request sanitization and required field validation.
- Add a compact local integration test harness using mocked ServiceNow responses.

### Post-Hackathon

- OAuth, SSO, delegated user authorization, and per-user ServiceNow attribution.
- Full provider-neutral agent runtime with durable traces outside compact ServiceNow event detail.
- Relationship promotion through approved ServiceNow mechanisms.
- Production ingestion connectors for source systems.
- Pagination, filtering, and large-run performance hardening.
- Schema changes only if compact event detail and existing findings/review decisions cannot support real audit needs.
- Multi-record approval policies and protected-service risk scoring.

### Explicit Non-Goals

- Replacing ServiceNow Discovery or Service Mapping.
- Writing directly to `cmdb_ci*` or `cmdb_rel_ci`.
- Letting an LLM construct authoritative IRE payloads.
- Letting an agent bypass validation, approval, fingerprint checks, or idempotency.
- Publishing or changing Identification Rules or Reconciliation Rules.
- Adding recommendation, agent trace, workflow state, or migration event tables during the hackathon without a proven need.
- Building a generic chatbot as the primary experience.

## 15. Revised Milestone Plan

### Milestone 5: Single-Record Remediation Workbench

**Status: Complete.** The browser no longer initiates Execute or Verify. A successful fingerprint-bound approval starts the server-owned Phase D continuation, and the workbench monitors persisted evidence through correlated verification.

- Objective: Make the Milestone 4 IRE control loop usable from the Keystone web app.
- User-visible outcome: A user selects one staged CI, runs simulation, reviews the actionable finding, approves or rejects, executes an approved operation, and verifies the result.
- Backend work: Harden `/api/cmdb/ire/[action]/route.ts` validation, normalize IRE responses, and add local request-shape tests if time allows.
- Frontend work: Add an IRE lifecycle panel, correlation display, idempotency handling for buttons, stale simulation errors, and verification summary.
- ServiceNow work: Confirm response fields and error codes for all four deployed IRE endpoints.
- Agent work: None required; expose deterministic tools that a future agent can call.
- Dependencies: Deployed ServiceNow endpoints and known response shapes.
- Acceptance criteria: Browser execute payload contains only identifiers and correlation metadata; stale simulation, duplicate idempotency, missing approval, and wrong verification correlation are visible and understandable.
- Risks: Endpoint response mismatch, missing compact fingerprint metadata, or insufficient event detail size.
- Deferred: Batch execution, relationship promotion, autonomous retry.

### Milestone 6: Derived Agent Work Queue And Playback

**Status: Complete.** Queue buckets, blockers, correlations, and lifecycle playback are deterministically reconstructed from staged records, findings, reviews, and Event Ledger evidence.

- Objective: Convert staged records, findings, review decisions, and event ledger entries into an agent-owned work queue.
- User-visible outcome: Users can see what the system is doing, what is queued, what is blocked, and what requires approval.
- Backend work: Add selectors or adapter utilities that derive lifecycle state from existing records and events.
- Frontend work: Replace static remediation cards with a queue, active task panel, and evidence-backed activity playback.
- ServiceNow work: Ensure event ledger entries have enough compact metadata for derivation.
- Agent work: Script deterministic queue progression for safe non-mutating steps.
- Dependencies: Stable event types and IRE endpoint metadata.
- Acceptance criteria: Refreshing the page reconstructs the same queue state from ServiceNow data.
- Risks: Event detail size and inconsistent event types.
- Deferred: Full model-driven orchestration.

### Milestone 7: Deterministic Failure Grouping And Retry Loop

**Status: Partially delivered through Phase E.** The bounded campaign coordinator plans stable homogeneous groups of at most 20, simulates at concurrency three, isolates item failures, exposes only the allowlisted class-alias retry evidence, freezes a canonical SHA-256 manifest, and fans one confirmation into sequential Phase D approvals. `bounded-insert-v1` also admits unmatched, complete `cmdb_ci_linux_server` INSERT simulations while freezing the policy and identity evidence in the manifest. The broad retry catalog and live 3–5 item INSERT acceptance campaign remain deferred.

- Objective: Demonstrate that Keystone can investigate repeated IRE failures and retry with allowed strategies.
- User-visible outcome: A set of failed simulations is grouped by shared cause; Keystone selects an allowed alternative and re-simulates.
- Backend work: Add deterministic failure classifiers and allowed retry strategy definitions.
- Frontend work: Add failure group panel, investigation timeline, retry evidence, and re-simulation results.
- ServiceNow work: Confirm simulation errors include enough structured detail.
- Agent work: Agent or scripted planner chooses among allowed strategies; deterministic services enforce the choice.
- Dependencies: Fixture data with realistic repeated failures.
- Acceptance criteria: At least one failure group is resolved by an allowed retry and one remains blocked for approval or data correction.
- Risks: IRE errors may be too unstructured for reliable grouping.
- Deferred: Broad retry strategy catalog.

### Milestone 8: Provider-Neutral Agent Harness

- Objective: Add a minimal agent orchestration layer without changing authority boundaries.
- User-visible outcome: Users see Comprehend, Prioritize, and Remediation agents progress safe work with real tool calls.
- Backend work: Define provider adapter, typed tool registry, structured outputs, and bounded execution loop.
- Frontend work: Show model reasoning summaries separately from deterministic tool results.
- ServiceNow work: No schema changes by default; continue compact event ledger metadata.
- Agent work: Implement Comprehend summaries, Prioritize grouping explanations, and Remediation planning for allowed actions.
- Dependencies: Milestone 6 queue and Milestone 7 failure tools.
- Acceptance criteria: Agent output cannot execute without ServiceNow validation and approval checks.
- Risks: Nondeterministic model output, overlong traces, or provider-specific coupling.
- Deferred: Long-running background workers and production scheduling.

### Milestone 9: Relationship And Service Impact Readiness

- Objective: Use relationship context to assess migration and remediation risk.
- User-visible outcome: Users understand whether an operation affects relationships, orphan records, or Service Mapping readiness.
- Backend work: Add relationship readiness scoring and endpoint dependency checks.
- Frontend work: Add graph-based risk annotations and relationship-blocked states.
- ServiceNow work: Continue staging relationships; do not promote relationships until endpoint CIs are verified.
- Agent work: Explain relationship blockers and recommend data-source fixes.
- Dependencies: Reliable staged relationship data.
- Acceptance criteria: Keystone prevents relationship promotion until endpoint CIs are executed and verified.
- Risks: Confusing source-file relationships with runtime Service Mapping dependencies.
- Deferred: Native Service Mapping replacement.

## 16. Demo Narrative

1. User selects or uploads a realistic migration dataset containing servers, applications, databases, endpoint metadata, relationships, and dirty data.
2. Keystone stages the data in ServiceNow and opens the migration run.
3. Comprehend Agent activity appears from real staged records and event ledger entries: source structure detected, records normalized, classes proposed, duplicate candidates identified, and relationship graph built.
4. Prioritize Agent groups repeated problems: missing serials, hostname collisions, unsupported class aliases, malformed CIDRs, and orphan relationships.
5. Remediation Agent selects simulation-ready server records and prepares non-authoritative previews.
6. Keystone calls ServiceNow IRE simulation for selected staged CIs.
7. A group of simulations fails because hostname is not unique.
8. The agent investigates the shared failure pattern and selects BIOS UUID as an allowed alternative identifier for the affected records.
9. Keystone requests rebuilt simulations through ServiceNow; most records pass.
10. One or two operations require meaningful administrator approval because of low confidence, duplicate candidate ambiguity, or protected service impact.
11. The user approves one action from the Keystone workbench.
12. Keystone executes the approved operation through ServiceNow IRE using an identifier-only request.
13. ServiceNow verifies the resulting CI using the execution correlation ID.
14. Keystone summarizes the actual result, remaining blocked work, and the next safe item.

For the current repository, steps 1-4 are partially supported by staging, adapters, live timeline, and mock/demo fallback. Steps 5-13 require the next implementation milestone to wire the UI to the deployed IRE endpoints and derive the work queue. Any demo event not backed by live ServiceNow data must be clearly labeled as fixture-driven.

## 17. Risks And Tradeoffs

- Limited hackathon time favors a single-record vertical slice over broad but shallow autonomy.
- Small fixture datasets may make the product feel scripted unless the dirty-data cases are realistic.
- Agent nondeterminism can undermine trust unless deterministic services own validation and execution boundaries.
- ServiceNow IRE API behavior and response shapes may vary between `identifyCI`, `identifyCIEnhanced`, REST query, and enhanced REST endpoints.
- ServiceNow role configuration can block demos if not validated early.
- Existing `payload` and `event_ledger.detail` string sizes may constrain compact metadata.
- Relationship promotion is important but should remain deferred until endpoint CIs are verified.
- Overbuilding the visual experience before the control loop works would risk a polished but hollow demo.
- Adding schema too early would increase deployment and governance risk.
- Demo fallback is useful, but it can damage credibility if users cannot distinguish fixture activity from live ServiceNow-backed activity.

## 18. Open Questions

- What are the exact response shapes and error fields for the four deployed ServiceNow IRE endpoints?
- Which 10 classes and 19 attributes are currently allowlisted in ServiceNow?
- Which users or roles can approve high-risk actions during the hackathon demo?
- Will the hackathon demo use a real LLM agent, a deterministic scripted agent, or a hybrid with model-generated summaries only?
- What fixture dataset will best demonstrate repeated failures, allowed retry, approval, execution, and verification?
- Does the existing 4,000-character `event_ledger.detail` field reliably hold compact fingerprint and lifecycle metadata?
- How should IRE simulation result classifications map to UI states and finding types?
- How should protected services or high-impact relationships be identified without Service Mapping replacement claims?
- Should ServiceNow update-set or script artifacts be source-controlled in this repository?
- Should `/api/cmdb/remediate` remain as a proposal route after the IRE workbench exists, or should it become a compatibility wrapper over the deterministic tool layer?
- Which provider should be used first for the minimal agent harness, and what is the fallback behavior when no model is configured?

## Final Assessment

### Does The Current Architecture Support The Vision?

Yes, with important gaps. The current architecture has the right authority boundary: ServiceNow owns staging, findings, reviews, event ledger, IRE simulation, execution, and verification, while Keystone owns the user experience and safe proxy/tool surface. The six-table schema is enough for the hackathon if lifecycle state is derived from event ledger, findings, review decisions, and IRE metadata. The main missing piece is not architecture; it is orchestration and UX: Keystone needs a real workbench that connects live staged records to the Milestone 4 IRE loop and then to a constrained agent tool layer.

### Five Most Important Changes Required

1. Build the single-record IRE workbench in the UI and wire it to `/api/cmdb/ire/simulate`, `/approve`, `/execute`, and `/verify`.
2. Add a derived work queue from staged records, findings, review decisions, and event ledger entries.
3. Add deterministic eligibility, grouping, and failure-classification logic before introducing model-driven planning.
4. Replace static agent claims with event-backed activity for active migration runs.
5. Add route-level and adapter-level tests for IRE request sanitization, lifecycle derivation, missing config, stale simulation, idempotency, and verification correlation.

### Highest-Impact Achievable Hackathon Scope

The best hackathon target is a single-record-to-small-batch remediation loop: upload or select a realistic run, show Comprehend/Prioritize activity from staged data, select eligible work, simulate through ServiceNow IRE, group one repeated failure, retry with an allowed deterministic strategy, request approval for one meaningful action, execute through IRE, verify the result, and summarize remaining work.

This proves the product thesis better than broad autonomous claims because it shows actual governed work moving through ServiceNow.

### Features To Reject Or Defer

- Direct CMDB write tools.
- Generic chatbot-first interface.
- New ServiceNow recommendation, agent trace, or workflow state tables during the hackathon.
- Relationship promotion before endpoint CIs are verified.
- Service Mapping replacement claims.
- Identification Rule or Reconciliation Rule authoring.
- Fully autonomous execution of ambiguous or protected operations.
- Large multi-record execution before the single-record fingerprint, approval, idempotency, and verification loop is proven.

### Recommended Next Codex Implementation Prompt

```text
Implement Keystone Milestone 5: Single-Record Remediation Workbench.

Read docs/keystone-agentic-cmdb-prd.md, docs/ire-flow.md, docs/cmdb-bridge-api.md, app/api/cmdb/ire/[action]/route.ts, app/lib/cmdb/ire.ts, app/cmdb-dashboard.tsx, and app/lib/cmdb/comprehend-adapter.ts.

Add a user-facing single-staged-CI IRE workbench that:
- selects a staged CI from the active migration run;
- calls /api/cmdb/ire/simulate with identifiers, correlation_id, and idempotency_key;
- displays simulation result, actionable finding, fingerprint/freshness metadata, and blockers;
- calls /api/cmdb/ire/approve for one actionable finding without duplicating findings;
- calls /api/cmdb/ire/execute with identifiers only, including simulation_correlation_id and execution idempotency metadata;
- calls /api/cmdb/ire/verify tied to the execution_correlation_id;
- shows derived lifecycle states and event-ledger playback;
- prevents double-click duplicate execution in the browser while relying on ServiceNow for authoritative idempotency;
- never sends final operation, target class, target CI, CMDB values, or authoritative IRE payload from the browser.

Preserve existing /api/cmdb/* compatibility routes. Do not add ServiceNow fields or tables. Run npm run build and npm run lint. Add focused tests for request sanitization and lifecycle derivation if the repository test setup allows it.
```
