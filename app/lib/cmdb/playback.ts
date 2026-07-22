import type { TimelineEvent } from "../../cmdb-data";

/**
 * Event Ledger playback model.
 *
 * The Comprehend "Event Ledger playback" graph is a fixed row of seven workflow
 * nodes (the pipeline phases). This module builds ONE deterministic sequence of
 * playback frames from real run evidence and maps every frame to the workflow
 * node(s) it actually proves participated — without collapsing parallel agent
 * work into a fake linear order and without lighting a node just because its
 * name happens to appear inside some raw JSON blob.
 *
 * The seven node IDs below are the repository's real graph nodes; their labels
 * match the existing stepper exactly so no visual redesign is required.
 */
export type PlaybackNodeId =
  | "intake"
  | "staging"
  | "ai-read"
  | "confidence-gate"
  | "ire"
  | "cmdb"
  | "event-log";

export const PLAYBACK_NODES: { id: PlaybackNodeId; label: string }[] = [
  { id: "intake", label: "Intake" },
  { id: "staging", label: "Staging" },
  { id: "ai-read", label: "AI read" },
  { id: "confidence-gate", label: "Confidence gate" },
  { id: "ire", label: "IRE" },
  { id: "cmdb", label: "CMDB" },
  { id: "event-log", label: "Event log" },
];

const NODE_LABEL = new Map<PlaybackNodeId, string>(PLAYBACK_NODES.map(node => [node.id, node.label]));
export function playbackNodeLabel(id: PlaybackNodeId | undefined): string {
  return id ? NODE_LABEL.get(id) ?? id : "—";
}

/** Result of mapping a single ledger event onto the workflow graph. */
export type PlaybackNodeMapping = {
  /** The single node this event primarily drives, if any. */
  primaryNodeId?: PlaybackNodeId;
  /** Additional nodes only when the event explicitly proves they participated. */
  relatedNodeIds: PlaybackNodeId[];
};

/** A single, ordered step of the playback timeline. */
export type PlaybackFrame = {
  id: string;
  seq: number;
  time: string;
  actor: string;
  title: string;
  detail: string;
  status: TimelineEvent["status"] | "derived";
  confidence: number;
  primaryNodeId?: PlaybackNodeId;
  relatedNodeIds: PlaybackNodeId[];
  /** True for the display-only staging frame synthesized from staged-record evidence. */
  derived: boolean;
  /** Ledger event ids backing this frame (empty for a derived frame). */
  eventIds: string[];
};

// Known agents own a specific node (or, for oversight, none). Everything keyed
// here is a normalized `event.source`. Mara is deliberately absent: it is the
// run's oversight/foreman actor and does not own a workflow node.
const AGENT_NODE: Record<string, PlaybackNodeId> = {
  router: "staging",
  atlas: "ai-read",
  scout: "ai-read",
  scouter: "ai-read",
  weaver: "ai-read",
  sentry: "confidence-gate",
  ledger: "event-log",
  ire: "ire",
};

const KNOWN_AGENTS = new Set<string>([...Object.keys(AGENT_NODE), "mara"]);

// Concrete ledger actions ("Action: <name>") map unambiguously to one node.
const ACTION_NODE: Record<string, PlaybackNodeId> = {
  get_run_stats: "staging",
  scan_classes: "ai-read",
  scan_attributes: "ai-read",
  scan_duplicates: "ai-read",
  scan_orphans: "ai-read",
  apply_confidence_gate: "confidence-gate",
  write_summary: "event-log",
};

function normalizeAgent(source: string): string {
  return source.trim().toLowerCase();
}

/** Extract an explicit `Action: <name>` token from ledger detail, if present. */
function parseAction(reasoning: string): string | undefined {
  return reasoning.match(/\bAction:\s*([a-z0-9_]+)/i)?.[1]?.toLowerCase();
}

// Milestone keywords describe the *event type*, not an agent name. Ordered most
// specific first. These never inspect who is mentioned inside a JSON blob.
function milestoneNode(event: TimelineEvent): PlaybackNodeId | undefined {
  const text = `${event.name} ${event.reasoning}`.toLowerCase();
  if (/\bseed data created\b|\bsource received\b|\bfile[_ ]received\b|\bingested\b|\bintake\b/.test(text)) return "intake";
  if (/\brecord[_ ]staged\b|\bstaged safely\b|\bstaged in\b|\bquarantine\b/.test(text)) return "staging";
  if (/\bconfidence (?:gate|passed|threshold)\b|\bgate applied\b/.test(text)) return "confidence-gate";
  if (/\bclassif|\bclass scan\b|\battribute scan\b|\bduplicate scan\b|\borphan scan\b/.test(text)) return "ai-read";
  if (/\bsimulat|\bapprov|\bire reconcil|\bire simulation\b/.test(text)) return "ire";
  if (/\bcommitt|\bcmdb publish|\bpublished\b|\bire_execution\b/.test(text)) return "cmdb";
  if (/\bverif|\bread-?back\b|\bledger sealed\b|\bexecutive summary\b/.test(text)) return "event-log";
  return undefined;
}

function stepToNode(step: number): PlaybackNodeId | undefined {
  return PLAYBACK_NODES[step - 1]?.id;
}

/**
 * Deterministically map one ledger event to the workflow node(s) it drives.
 *
 * Precedence (all explicit — never substring-matches an agent name in raw JSON):
 *   1. Mara / oversight actors own no node (unless they carry a concrete Action).
 *   2. Concrete `Action:` token.
 *   3. Event-type milestone keywords.
 *   4. Known-agent ownership.
 *   5. For non-agent sources (demo / source-system rows) fall back to the
 *      pipeline phase the adapter already computed.
 * Anything unresolved highlights nothing.
 */
export function mapPlaybackEventToNodes(event: TimelineEvent): PlaybackNodeMapping {
  const agent = normalizeAgent(event.source);
  const action = parseAction(event.reasoning);
  const empty: PlaybackNodeMapping = { relatedNodeIds: [] };

  // 1. Oversight actor: highlight nothing unless it emitted a concrete action.
  if (agent === "mara") {
    const actionNode = action ? ACTION_NODE[action] : undefined;
    return actionNode ? { primaryNodeId: actionNode, relatedNodeIds: [] } : empty;
  }

  // 2. Concrete action.
  if (action && ACTION_NODE[action]) {
    return { primaryNodeId: ACTION_NODE[action], relatedNodeIds: [] };
  }

  // 3. Event-type milestone.
  const milestone = milestoneNode(event);
  if (milestone) return { primaryNodeId: milestone, relatedNodeIds: [] };

  // 4. Known-agent ownership.
  if (KNOWN_AGENTS.has(agent)) {
    const node = AGENT_NODE[agent];
    return node ? { primaryNodeId: node, relatedNodeIds: [] } : empty;
  }

  // 5. Non-agent source rows: trust the adapter-computed phase.
  const stepNode = stepToNode(event.step);
  return stepNode ? { primaryNodeId: stepNode, relatedNodeIds: [] } : empty;
}

const DERIVED_STAGING_FRAME_ID = "derived-staging";
export const DERIVED_STAGING_TITLE = "Data staged in ServiceNow quarantine";

/** Parse a ServiceNow-style timestamp to a comparable number, or undefined. */
function timeValue(value: string): number | undefined {
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  const sn = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/);
  if (sn) {
    const parsed = Date.parse(`${sn[1]}T${sn[2]}Z`);
    if (Number.isFinite(parsed)) return parsed;
  }
  // Bare clock times ("06:08:41.318") keep their lexical order, which matches
  // chronological order within a single run.
  return undefined;
}

function activeNodesOfMapping(mapping: PlaybackNodeMapping): PlaybackNodeId[] {
  const nodes: PlaybackNodeId[] = [];
  if (mapping.primaryNodeId) nodes.push(mapping.primaryNodeId);
  for (const node of mapping.relatedNodeIds) if (!nodes.includes(node)) nodes.push(node);
  return nodes;
}

/**
 * Build the single deterministic playback timeline from real run evidence.
 *
 * Ordering: ledger sequence ascending, then timestamp ascending, then the
 * event's stable original index. Events sharing an identical (seq, time) are the
 * same recorded frame and may light multiple nodes in parallel.
 *
 * Staging-first: when the run has staged records but never emitted an explicit
 * intake/staging ledger event, a single display-only derived frame is prepended
 * so the story opens where the data actually entered ServiceNow.
 */
export function buildPlaybackTimeline({
  timeline,
  stagedCiCount = 0,
}: {
  timeline: TimelineEvent[];
  stagedCiCount?: number;
}): PlaybackFrame[] {
  const ordered = timeline
    .map((event, index) => ({ event, index }))
    .sort((a, b) => {
      if (a.event.seq !== b.event.seq) return a.event.seq - b.event.seq;
      const at = timeValue(a.event.time);
      const bt = timeValue(b.event.time);
      if (at !== undefined && bt !== undefined && at !== bt) return at - bt;
      return a.index - b.index;
    });

  const frames: PlaybackFrame[] = [];
  let cursor = 0;
  while (cursor < ordered.length) {
    // Group events that share the same (seq, time) into one parallel frame.
    const head = ordered[cursor];
    const group = [head];
    let next = cursor + 1;
    while (
      next < ordered.length &&
      ordered[next].event.seq === head.event.seq &&
      ordered[next].event.time === head.event.time
    ) {
      group.push(ordered[next]);
      next += 1;
    }
    cursor = next;

    const mappings = group.map(item => mapPlaybackEventToNodes(item.event));
    let primaryNodeId: PlaybackNodeId | undefined;
    const related: PlaybackNodeId[] = [];
    for (const mapping of mappings) {
      for (const node of activeNodesOfMapping(mapping)) {
        if (primaryNodeId === undefined) primaryNodeId = node;
        else if (node !== primaryNodeId && !related.includes(node)) related.push(node);
      }
    }
    // The owning event is the one that contributed the primary node, so the
    // activity text always matches the highlighted frame.
    const ownerIndex = primaryNodeId
      ? Math.max(0, mappings.findIndex(m => activeNodesOfMapping(m).includes(primaryNodeId as PlaybackNodeId)))
      : 0;
    const owner = group[ownerIndex].event;

    frames.push({
      id: owner.id,
      seq: owner.seq,
      time: owner.time,
      actor: owner.source,
      title: owner.name,
      detail: owner.reasoning,
      status: owner.status,
      confidence: owner.confidence,
      primaryNodeId,
      relatedNodeIds: related,
      derived: false,
      eventIds: group.map(item => item.event.id),
    });
  }

  const hasStagingEvidence = frames.some(
    frame => frame.primaryNodeId === "intake" ||
      frame.primaryNodeId === "staging" ||
      frame.relatedNodeIds.includes("intake") ||
      frame.relatedNodeIds.includes("staging"),
  );

  if (!hasStagingEvidence && stagedCiCount > 0) {
    const firstSeq = frames.length ? frames[0].seq : 1;
    frames.unshift({
      id: DERIVED_STAGING_FRAME_ID,
      seq: firstSeq - 1,
      time: frames.length ? frames[0].time : "",
      actor: "Staging",
      title: DERIVED_STAGING_TITLE,
      detail: `${stagedCiCount.toLocaleString()} record${stagedCiCount === 1 ? "" : "s"} held in the ServiceNow quarantine table. Derived UI evidence — not a backend tool call.`,
      status: "derived",
      confidence: 0,
      primaryNodeId: "staging",
      relatedNodeIds: [],
      derived: true,
      eventIds: [],
    });
  }

  return frames;
}

export type PlaybackNodeStatus = "active" | "done" | "upcoming" | "untouched";

export type PlaybackNodeStates = {
  states: Record<PlaybackNodeId, PlaybackNodeStatus>;
  /** First frame index at which each node becomes active (for click-to-seek). */
  firstFrameForNode: Partial<Record<PlaybackNodeId, number>>;
  /** The single stage the progress light sits on (furthest stage reached). */
  activeNodeId?: PlaybackNodeId;
};

function activeNodesOfFrame(frame: PlaybackFrame | undefined): PlaybackNodeId[] {
  if (!frame) return [];
  const nodes: PlaybackNodeId[] = [];
  if (frame.primaryNodeId) nodes.push(frame.primaryNodeId);
  for (const node of frame.relatedNodeIds) if (!nodes.includes(node)) nodes.push(node);
  return nodes;
}

const NODE_ORDER = new Map<PlaybackNodeId, number>(PLAYBACK_NODES.map((node, index) => [node.id, index]));

/**
 * Compute each workflow node's visual status for the frame at `activeIndex`,
 * as a clean left-to-right pipeline progression.
 *
 * The progress light sits on the *furthest stage reached* so far. Because that
 * is a running maximum over the stages that have actually occurred, the light
 * only ever advances rightward and never blanks — an oversight/unknown frame
 * (which owns no node) simply leaves it where it was while the detail panel
 * continues through the real ledger event.
 *
 * - Stages that occurred and sit before the light are `done`.
 * - The furthest reached stage is `active`.
 * - Stages that occur only later are `upcoming`.
 * - Stages that never occur in this run stay `untouched` (even when the light is
 *   already past them), so a skipped stage is never falsely shown as completed.
 */
export function derivePlaybackNodeStates(
  frames: PlaybackFrame[],
  activeIndex: number,
): PlaybackNodeStates {
  const firstFrameForNode: Partial<Record<PlaybackNodeId, number>> = {};
  frames.forEach((frame, index) => {
    for (const node of activeNodesOfFrame(frame)) {
      if (firstFrameForNode[node] === undefined) firstFrameForNode[node] = index;
    }
  });
  const occurred = new Set<PlaybackNodeId>(Object.keys(firstFrameForNode) as PlaybackNodeId[]);

  const clamped = frames.length ? Math.min(Math.max(activeIndex, 0), frames.length - 1) : -1;

  // Furthest stage reached through the current frame (monotonic, never rewinds).
  let progressOrder = -1;
  for (let i = 0; i <= clamped; i += 1) {
    for (const node of activeNodesOfFrame(frames[i])) {
      const order = NODE_ORDER.get(node);
      if (order !== undefined && order > progressOrder) progressOrder = order;
    }
  }

  const states = {} as Record<PlaybackNodeId, PlaybackNodeStatus>;
  let activeNodeId: PlaybackNodeId | undefined;
  for (const { id } of PLAYBACK_NODES) {
    const order = NODE_ORDER.get(id) as number;
    if (!occurred.has(id)) states[id] = "untouched";
    else if (progressOrder < 0 || order > progressOrder) states[id] = "upcoming";
    else if (order === progressOrder) { states[id] = "active"; activeNodeId = id; }
    else states[id] = "done";
  }

  return { states, firstFrameForNode, activeNodeId };
}
