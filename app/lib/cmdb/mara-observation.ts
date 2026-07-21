// Tolerant parser for Mara ledger `Observation:` payloads.
//
// The Event Ledger can hand us:
//   - a clean JSON object
//   - "Observation: {...}"
//   - truncated / malformed JSON
//   - freeform text
//
// The bubble must NEVER render the original message. If parsing fails, this
// helper still returns a readable summary derived from known fields via
// regex, and the raw source is only exposed through Technical evidence.

export type MaraRecordChip = {
  id?: string;
  name?: string;
  proposedClass?: string;
  confidence?: number;
  status?: string;
};

export type MaraObservation = {
  summaryText: string;
  chips: string[];
  records: MaraRecordChip[];
  technicalRaw: string;
};

export const MARA_FALLBACK_SUMMARY =
  "I recorded new migration evidence. Open technical evidence to inspect the source data.";

type ExtractedFields = {
  readyCount?: number;
  heldCount?: number;
  affectedCount?: number;
  confidence?: number;
  proposedClass?: string;
  identificationStatus?: string;
  number?: string;
  sourceIdentifier?: string;
};

export function parseMaraObservation(raw: string): MaraObservation {
  const source = (raw || "").trim();
  if (!source) return { summaryText: MARA_FALLBACK_SUMMARY, chips: [], records: [], technicalRaw: "" };

  // Strip chain-of-thought and any leading "Observation:" marker before parsing.
  const withoutThought = source.replace(/^Thought\s*:\s*[^|]*\|\s*/i, "");
  const observationBody = withoutThought.replace(/^[\s\S]*?Observation\s*:\s*/i, "").trim();
  const candidate = observationBody || withoutThought.trim();

  const parsed = tryJsonParse(candidate);
  const fields = parsed ? extractFromObject(parsed) : extractFromRegex(candidate);
  const records = parsed ? extractRecordsFromObject(parsed) : extractRecordsFromRegex(candidate);

  const summaryText = buildSummary(fields);
  const chips = buildChips(fields);
  const technicalRaw = formatTechnicalSource(source, parsed);
  return { summaryText, chips, records, technicalRaw };
}

export function formatTechnicalSource(raw: string, parsedOverride?: unknown): string {
  const trimmed = (raw || "").trim();
  if (!trimmed) return "(empty)";
  const body = trimmed.replace(/^[\s\S]*?Observation\s*:\s*/i, "");
  const parsed = parsedOverride ?? tryJsonParse(body || trimmed);
  if (parsed && typeof parsed === "object") {
    try { return JSON.stringify(parsed, null, 2); } catch { /* fall through */ }
  }
  return trimmed;
}

function extractFromObject(payload: unknown): ExtractedFields {
  if (!payload || typeof payload !== "object") return {};
  const raw = payload as Record<string, unknown>;
  const confidence = numberFrom(raw, ["confidence"]);
  return {
    readyCount: numberFrom(raw, ["ready_count", "ready", "ready_for_simulation"]),
    heldCount: numberFrom(raw, ["held_count", "held", "held_for_review", "review_count"]),
    affectedCount: numberFrom(raw, ["affected_count", "affected", "affected_records"]),
    confidence: confidence === undefined ? undefined : normalizeConfidence(confidence),
    proposedClass: stringFrom(raw, ["proposed_class"]),
    identificationStatus: stringFrom(raw, ["identification_status", "identity_status"]),
    number: stringFrom(raw, ["number"]),
    sourceIdentifier: stringFrom(raw, ["source_identifier"]),
  };
}

function extractFromRegex(candidate: string): ExtractedFields {
  return {
    readyCount: matchNumber(candidate, /"?ready_count"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i),
    heldCount: matchNumber(candidate, /"?held_count"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i),
    affectedCount: matchNumber(candidate, /"?affected(?:_records|_count)?"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i),
    confidence: normalizeConfidenceOptional(matchNumber(candidate, /"?confidence"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i)),
    proposedClass: matchString(candidate, /"?proposed_class"?\s*[:=]\s*"([^"]+)"/i)
      ?? matchString(candidate, /"?proposed_class"?\s*[:=]\s*([A-Za-z0-9_.\-]+)/i),
    identificationStatus: matchString(candidate, /"?identification_status"?\s*[:=]\s*"([^"]+)"/i),
    number: matchString(candidate, /"?number"?\s*[:=]\s*"([^"]+)"/i),
    sourceIdentifier: matchString(candidate, /"?source_identifier"?\s*[:=]\s*"([^"]+)"/i),
  };
}

function extractRecordsFromObject(payload: unknown): MaraRecordChip[] {
  if (!payload || typeof payload !== "object") return [];
  const raw = payload as Record<string, unknown>;
  const arrays: unknown[] = [];
  for (const key of ["records", "items", "results", "cis", "findings"]) {
    const value = raw[key];
    if (Array.isArray(value)) arrays.push(...value);
  }
  return arrays.slice(0, 24).map((entry): MaraRecordChip => {
    if (!entry || typeof entry !== "object") return {};
    const row = entry as Record<string, unknown>;
    const confidence = numberFrom(row, ["confidence"]);
    return {
      id: stringFrom(row, ["number", "id", "sys_id", "record_id"]),
      name: stringFrom(row, ["source_identifier", "name", "display_value", "record_name", "hostname", "identifier"]),
      proposedClass: stringFrom(row, ["proposed_class", "class", "className"]),
      confidence: confidence === undefined ? undefined : normalizeConfidence(confidence),
      status: stringFrom(row, ["identification_status", "status", "operation"]),
    };
  }).filter(record => record.id || record.name || record.proposedClass);
}

function extractRecordsFromRegex(candidate: string): MaraRecordChip[] {
  const blocks = candidate.match(/\{[^{}]*"number"[^{}]*\}?/g) ?? [];
  return blocks.slice(0, 24).map((block): MaraRecordChip => {
    const confidence = matchNumber(block, /"?confidence"?\s*:\s*(-?\d+(?:\.\d+)?)/i);
    return {
      id: matchString(block, /"?number"?\s*:\s*"([^"]+)"/i),
      name: matchString(block, /"?source_identifier"?\s*:\s*"([^"]+)"/i),
      proposedClass: matchString(block, /"?proposed_class"?\s*:\s*"([^"]+)"/i),
      confidence: confidence === undefined ? undefined : normalizeConfidence(confidence),
      status: matchString(block, /"?identification_status"?\s*:\s*"([^"]+)"/i),
    };
  }).filter(record => record.id || record.name || record.proposedClass);
}

function buildSummary(fields: ExtractedFields): string {
  const parts: string[] = [];
  if (fields.readyCount !== undefined) parts.push(`${fields.readyCount} record${fields.readyCount === 1 ? "" : "s"} ready for simulation`);
  if (fields.heldCount !== undefined) parts.push(`held ${fields.heldCount} for human review`);
  if (parts.length) return "I found " + joinList(parts) + ".";
  if (fields.affectedCount !== undefined) return `I recorded ${fields.affectedCount} affected record${fields.affectedCount === 1 ? "" : "s"}.`;
  if (fields.proposedClass || fields.identificationStatus) {
    const cls = fields.proposedClass ? `proposed class ${fields.proposedClass}` : "";
    const status = fields.identificationStatus ? `identification ${fields.identificationStatus}` : "";
    return "I noted " + joinList([cls, status].filter(Boolean)) + ".";
  }
  return MARA_FALLBACK_SUMMARY;
}

function buildChips(fields: ExtractedFields): string[] {
  const chips: string[] = [];
  if (fields.readyCount !== undefined) chips.push(`${fields.readyCount} ready`);
  if (fields.heldCount !== undefined) chips.push(`${fields.heldCount} held`);
  if (fields.affectedCount !== undefined && fields.readyCount === undefined && fields.heldCount === undefined) {
    chips.push(`${fields.affectedCount} affected`);
  }
  if (fields.confidence !== undefined) chips.push(`${fields.confidence}% confidence`);
  if (fields.proposedClass) chips.push(fields.proposedClass);
  if (fields.identificationStatus) chips.push(fields.identificationStatus);
  return chips;
}

function tryJsonParse(value: string): unknown {
  if (!value) return null;
  try { return JSON.parse(value); } catch { /* fall through */ }
  const match = value.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch { return null; }
}

function matchNumber(source: string, pattern: RegExp): number | undefined {
  const match = source.match(pattern);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isFinite(parsed) ? parsed : undefined;
}
function matchString(source: string, pattern: RegExp): string | undefined {
  const match = source.match(pattern);
  return match ? match[1].trim() : undefined;
}
function normalizeConfidence(value: number): number {
  return value <= 1 ? Math.round(value * 100) : Math.round(value);
}
function normalizeConfidenceOptional(value?: number): number | undefined {
  return value === undefined ? undefined : normalizeConfidence(value);
}
function numberFrom(payload: Record<string, unknown>, keys: string[]): number | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string" && value.trim() && !Number.isNaN(Number(value))) return Number(value);
  }
  return undefined;
}
function stringFrom(payload: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}
function joinList(parts: string[]): string {
  const filtered = parts.filter(Boolean);
  if (filtered.length <= 1) return filtered.join("");
  return filtered.slice(0, -1).join(", ") + " and " + filtered[filtered.length - 1];
}
