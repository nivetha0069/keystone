# Agent Harness

## Milestone 1 scope

Provider-neutral agent work is documentation-only in Milestone 1. Do not implement model calls, background agent execution, ServiceNow write tools, or a dedicated `agent_trace` table yet.

## Goals

Agents may interpret, classify, explain, and recommend. Deterministic code must validate required fields, calculate scores, enforce permissions, and execute writes through ServiceNow-controlled services.

Agent outputs are proposals, not facts.

## Conceptual interface

```ts
export interface KeystoneAgent<Input, Result> {
  id: string;
  name: string;
  version: string;
  capabilities: string[];
  analyze(input: Input, context: AgentContext): Promise<Result>;
}
```

The harness should eventually enforce:

- structured JSON input and output
- schema validation
- timeouts and retry limits
- provider abstraction
- trace id and prompt version
- agent version
- token and latency metrics
- evidence requirements
- confidence bounds
- abstention support
- no credential access
- no direct CMDB write tools
- allowlisted tables and tools only
- human approval before material action

## Initial persistence model

Do not add `recommendation` or `agent_trace` tables now.

Use existing tables:

- `finding`: stores concise findings, recommendations, or AI summaries. Use `type` as the record-kind discriminator where choices allow.
- `review_decision`: stores human or policy review of a finding.
- `event_ledger`: stores compact lifecycle metadata for agent start/completion/error and playback.

Do not store complete model prompts, complete model responses, full source rows, or large artifacts in `event_ledger.detail`.

## Class Mapping Agent, later milestone

The first future agent should recommend a target CMDB class from staged source attributes. It must return ranked candidates, evidence, confidence, and abstention when uncertain.

The deterministic gate remains responsible for:

- allowed target classes
- required identifiers
- confidence thresholds
- review requirements
- final ServiceNow write eligibility

## When separate tables become justified

A separate `recommendation` table becomes justified when recommendations need independent assignment, lifecycle, prioritization history, grouping, or execution status beyond what `finding` and `review_decision` can safely represent.

A separate `agent_trace` table becomes justified when audit requirements require searchable prompt versions, model IDs, token metrics, latency, full structured outputs, input hashes, or replay/debug data at a volume or size unsuitable for `finding` and compact `event_ledger` entries.

## Security rules

Agents must never receive ServiceNow credentials. They must not have unrestricted ServiceNow query tools, arbitrary encoded-query execution, browser-originated write access, or direct CMDB write capabilities. Server-side integration code and future ServiceNow Script Includes remain the only place where credentials and authoritative write orchestration belong.
