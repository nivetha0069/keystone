"use client";

import { useMemo } from "react";
import type { TimelineEvent } from "./cmdb-data";
import { Icon } from "./icons";

type LiveOpsApiState = "connecting" | "live" | "partial" | "demo";
type TimelineResourceStatus = "connecting" | "live" | "error";

export type LiveOpsViewProps = {
  timeline: TimelineEvent[];
  activeRunId: string;
  apiState: LiveOpsApiState;
  resourceStatus: TimelineResourceStatus;
  paused: boolean;
  refreshing: boolean;
  refreshCount: number;
  onPausedChange: (paused: boolean) => void;
  onRefresh: () => void;
};

type EventCategory = "actions" | "observations" | "lifecycle" | "gateResults" | "errors";
type EventCategoryCounts = Record<EventCategory, number>;

/*
 * Alex-authored simulator lines are preserved verbatim here and intentionally
 * disabled. Live Ops now renders only recorded ServiceNow Event Ledger data.
 *
 * const [activityClock, setActivityClock] = useState(0);
 * const activityTime = Date.now();
 * setActivityClock(activityTime);
 * for (const event of created) next[event.agent] = { task: event.text, at: activityTime };
 * const working = activity && activityClock - activity.at < 6000;
 */

function timestamp(value: string) {
  const direct = Date.parse(value);
  if (Number.isFinite(direct)) return direct;
  const serviceNow = value.match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})$/);
  if (!serviceNow) return undefined;
  const parsed = Date.parse(`${serviceNow[1]}T${serviceNow[2]}Z`);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function displayTime(value: string) {
  const parsed = timestamp(value);
  if (parsed === undefined) return value;
  return new Date(parsed).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function isError(event: TimelineEvent) {
  const detail = event.reasoning.trim();
  return event.status === "error"
    || event.operation === "ERROR"
    || /^(error|failure|exception)\s*:/i.test(detail);
}

function eventCategory(event: TimelineEvent): EventCategory {
  if (isError(event)) return "errors";
  if (gateResultFromEvent(event)) return "gateResults";
  if (/\bAction:\s*[a-z0-9_]+/i.test(event.reasoning)) return "actions";
  if (/\bObservation:/i.test(event.reasoning)) return "observations";
  return "lifecycle";
}

function eventLabel(event: TimelineEvent) {
  const labels: Record<EventCategory, string> = {
    actions: "ACTION",
    observations: "OBSERVATION",
    lifecycle: "LIFECYCLE",
    gateResults: "GATE RESULT",
    errors: "ERROR",
  };
  return labels[eventCategory(event)];
}

function eventTone(event: TimelineEvent) {
  const tones: Record<EventCategory, string> = {
    actions: "lime",
    observations: "green",
    lifecycle: "muted",
    gateResults: "amber",
    errors: "coral",
  };
  return tones[eventCategory(event)];
}

function throughputBuckets(events: TimelineEvent[], bucketCount = 12) {
  const timed = events
    .map(event => timestamp(event.time))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  if (timed.length < 2) return null;
  const first = timed[0];
  const last = timed[timed.length - 1];
  const range = last - first;
  if (range <= 0) return null;
  const buckets = Array.from({ length: bucketCount }, () => 0);
  for (const value of timed) {
    const index = Math.min(bucketCount - 1, Math.floor(((value - first) / range) * bucketCount));
    buckets[index] += 1;
  }
  return { buckets, timedCount: timed.length, range };
}

function confidenceBuckets(events: TimelineEvent[]) {
  const values = events
    .map(event => event.confidence)
    .filter(value => Number.isFinite(value) && value > 0 && value <= 1);
  const buckets = Array.from({ length: 10 }, () => 0);
  for (const value of values) buckets[Math.min(9, Math.floor(value * 10))] += 1;
  return { buckets, count: values.length };
}

function entriesPerMinute(events: TimelineEvent[]) {
  const timed = events
    .map(event => timestamp(event.time))
    .filter((value): value is number => value !== undefined)
    .sort((a, b) => a - b);
  if (timed.length < 2) return null;
  const elapsedMinutes = (timed[timed.length - 1] - timed[0]) / 60_000;
  if (elapsedMinutes <= 0) return null;
  return (timed.length - 1) / elapsedMinutes;
}

function namedCount(detail: string, label: "held" | "cleared") {
  const patterns = [
    new RegExp(`\\b(\\d+)\\s+(?:records?\\s+)?${label}\\b`, "i"),
    new RegExp(`\\b${label}\\s*[:=]\\s*(\\d+)\\b`, "i"),
    new RegExp(`\\b${label}\\s+(\\d+)\\b`, "i"),
  ];
  for (const pattern of patterns) {
    const match = detail.match(pattern);
    if (match) return Number(match[1]);
  }
  return undefined;
}

function gateResultFromEvent(event: TimelineEvent) {
  const detail = event.reasoning;
  if (!/\bconfidence gate\b/i.test(detail) || !/\bObservation:/i.test(detail)) return null;
  const held = namedCount(detail, "held");
  const cleared = namedCount(detail, "cleared");
  if (held === undefined || cleared === undefined || held + cleared <= 0) return null;
  return { held, cleared };
}

function gateResultForRun(events: TimelineEvent[]) {
  for (const event of [...events].sort((a, b) => b.seq - a.seq)) {
    const result = gateResultFromEvent(event);
    if (result) return result;
  }
  return null;
}

function ThroughputChart({ buckets }: { buckets: number[] }) {
  const max = Math.max(...buckets, 1);
  return <svg className="throughput-chart" viewBox="0 0 300 110" preserveAspectRatio="none" role="img" aria-label="Recorded Event Ledger entries across chronological intervals">
    {buckets.map((value, index) => {
      const height = (value / max) * 92;
      return <rect key={index} x={(index / buckets.length) * 300 + 2} y={104 - height} width={Math.max(4, 300 / buckets.length - 5)} height={Math.max(height, 2)} className={index === buckets.length - 1 ? "bar current" : "bar"} />;
    })}
    <line x1="0" y1="104.5" x2="300" y2="104.5" className="axis" />
  </svg>;
}

function Histogram({ buckets }: { buckets: number[] }) {
  const max = Math.max(...buckets, 1);
  return <div className="histogram" role="img" aria-label="Distribution of recorded Event Ledger confidence">
    <svg viewBox="0 0 300 110" preserveAspectRatio="none">
      {buckets.map((value, index) => {
        const height = (value / max) * 92;
        const tone = index >= 9 ? "lime" : index >= 7 ? "green" : index >= 5 ? "amber" : "coral";
        return <rect key={index} x={index * 30 + 3} y={104 - height} width={24} height={Math.max(height, 2)} className={`bar ${tone}`} />;
      })}
      <line x1="0" y1="104.5" x2="300" y2="104.5" className="axis" />
    </svg>
    <div className="histogram-scale"><span>0%</span><span>50%</span><span>75%</span><span>100%</span></div>
  </div>;
}

function EventCategoryDonut({ categories }: { categories: EventCategoryCounts }) {
  const segments = [
    { value: categories.actions, label: "Actions", cls: "lime" },
    { value: categories.observations, label: "Observations", cls: "green" },
    { value: categories.lifecycle, label: "Lifecycle", cls: "muted" },
    { value: categories.gateResults, label: "Gate results", cls: "amber" },
    { value: categories.errors, label: "Errors", cls: "coral" },
  ];
  const total = segments.reduce((sum, segment) => sum + segment.value, 0);
  const radius = 40;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  return <div className="donut-wrap">
    <svg viewBox="0 0 110 110" role="img" aria-label="Recorded Event Ledger entries grouped by semantic event type">
      {segments.map(segment => {
        const fraction = total ? segment.value / total : 0;
        const element = <circle key={segment.label} cx="55" cy="55" r={radius} className={`donut-seg ${segment.cls}`}
          strokeDasharray={`${fraction * circumference} ${circumference}`} strokeDashoffset={-offset * circumference} transform="rotate(-90 55 55)" />;
        offset += fraction;
        return element;
      })}
      <text x="55" y="52" className="donut-number">{total.toLocaleString()}</text>
      <text x="55" y="66" className="donut-caption">LEDGER EVENTS</text>
    </svg>
    <div className="donut-legend">
      {segments.map(segment => <span key={segment.label}><i className={`${segment.cls}-bg`} /> {segment.label} · {segment.value}</span>)}
    </div>
  </div>;
}

export function LiveOpsView({
  timeline,
  activeRunId,
  apiState,
  resourceStatus,
  paused,
  refreshing,
  refreshCount,
  onPausedChange,
  onRefresh,
}: LiveOpsViewProps) {
  const newestFirst = useMemo(() => [...timeline].sort((a, b) => b.seq - a.seq), [timeline]);
  const rate = useMemo(() => entriesPerMinute(timeline), [timeline]);
  const throughput = useMemo(() => throughputBuckets(timeline), [timeline]);
  const confidence = useMemo(() => confidenceBuckets(timeline), [timeline]);
  const gate = useMemo(() => gateResultForRun(timeline), [timeline]);
  const categories = useMemo(() => timeline.reduce<EventCategoryCounts>((counts, event) => {
    counts[eventCategory(event)] += 1;
    return counts;
  }, { actions: 0, observations: 0, lifecycle: 0, gateResults: 0, errors: 0 }), [timeline]);
  const latestByActor = useMemo(() => {
    const latest = new Map<string, TimelineEvent>();
    for (const event of newestFirst) {
      const actor = event.source.trim() || "Unknown actor";
      if (!latest.has(actor)) latest.set(actor, event);
    }
    const preferredOrder = ["Comprehend", "Router", "Atlas", "Scout", "Weaver", "Sentry", "Ledger"];
    return Array.from(latest.entries()).sort(([left], [right]) => {
      const leftIndex = preferredOrder.indexOf(left);
      const rightIndex = preferredOrder.indexOf(right);
      if (leftIndex >= 0 || rightIndex >= 0) {
        if (leftIndex < 0) return 1;
        if (rightIndex < 0) return -1;
        return leftIndex - rightIndex;
      }
      return left.localeCompare(right);
    });
  }, [newestFirst]);

  const gateTotal = gate ? gate.held + gate.cleared : 0;
  const gateRate = gate && gateTotal ? `${((gate.held / gateTotal) * 100).toFixed(0)}%` : "—";
  const rateLabel = rate === null ? "—" : rate < 10 ? rate.toFixed(1) : Math.round(rate).toLocaleString();
  const emptyMessage = !activeRunId
    ? "Select a migration run to view live agent activity."
    : resourceStatus === "error"
      ? "Event Ledger is unavailable for this run."
      : resourceStatus === "live" && !timeline.length
        ? "No Event Ledger activity has been recorded for this run."
        : "";
  const streamStatus = !activeRunId
    ? "Waiting for a run"
    : resourceStatus === "error"
      ? "Event Ledger unavailable"
      : paused
        ? "Polling paused"
        : refreshing
          ? "Refreshing Event Ledger"
          : resourceStatus === "connecting"
            ? "Loading Event Ledger"
            : "Polling recorded activity";

  function togglePaused() {
    if (paused) {
      onPausedChange(false);
      onRefresh();
      return;
    }
    onPausedChange(true);
  }

  return <div className="page">
    <section className="page-heading">
      <div>
        <span className="eyebrow accent">LIVE OPS</span>
        <h1>Watch the recorded agent trail.</h1>
        <p>Live Ops displays recorded Event Ledger activity. It does not execute CMDB writes.</p>
      </div>
      <div className="run-state">
        <span className={!paused && activeRunId && resourceStatus === "live" ? "run-pulse" : "run-pulse paused"} />
        <div><small>EVENT LEDGER</small><strong>{streamStatus}</strong></div>
        <button className="ghost-button" disabled={!activeRunId || refreshing} onClick={onRefresh} aria-label="Refresh Event Ledger">
          <Icon name="refresh" size={15} />{refreshing ? "Refreshing" : "Refresh"}
        </button>
        <button className="play-button" disabled={!activeRunId} onClick={togglePaused}>
          <Icon name={paused ? "play" : "pause"} size={15} />{paused ? "Resume" : "Pause"}
        </button>
      </div>
    </section>

    <section className="kpi-grid">
      <div className="kpi-card lime"><div className="kpi-top"><span>Ledger events this run</span><span className="kpi-icon"><Icon name="bolt" size={17} /></span></div><strong>{activeRunId ? timeline.length.toLocaleString() : "—"}</strong><div className="kpi-foot"><span>real ledger entries</span><i /></div></div>
      <div className="kpi-card green"><div className="kpi-top"><span>Ledger entries / min</span><span className="kpi-icon"><Icon name="pulse" size={17} /></span></div><strong>{activeRunId ? rateLabel : "—"}</strong><div className="kpi-foot"><span>from this run&apos;s recorded timestamp range</span><i /></div></div>
      <div className="kpi-card amber"><div className="kpi-top"><span>Gate hold rate</span><span className="kpi-icon"><Icon name="shield" size={17} /></span></div><strong>{activeRunId ? gateRate : "—"}</strong><div className="kpi-foot"><span>{activeRunId && gate ? `${gate.held} held · ${gate.cleared} cleared` : "no recorded gate result"}</span><i /></div></div>
      <div className="kpi-card coral"><div className="kpi-top"><span>Ledger refreshes</span><span className="kpi-icon"><Icon name="clock" size={17} /></span></div><strong>{refreshCount}</strong><div className="kpi-foot"><span>since this run opened</span><i /></div></div>
    </section>

    {emptyMessage ? <section className="panel live-empty-state">
      <Icon name={resourceStatus === "error" ? "alert" : "clock"} size={23} />
      <strong>{emptyMessage}</strong>
      <p>{!activeRunId ? "Open a staged run from Import or paste its migration_run sys_id in Comprehend." : "No simulated events are substituted."}</p>
    </section> : <>
      <section className="live-grid">
        <div className="panel feed-panel">
          <div className="panel-heading compact">
            <div><span className="section-index">01</span><div><h2>Agent stream</h2><p>Newest recorded ledger sequence first</p></div></div>
            <span className="panel-stat"><i className={resourceStatus === "live" ? "live-dot" : "live-dot demo"} /> {paused ? "PAUSED" : apiState === "live" ? "LIVE" : apiState.toUpperCase()}</span>
          </div>
          <div className="feed" aria-live="polite">
            {newestFirst.map(event => <div className="feed-item" key={event.id}>
              <span className="feed-time" title={event.time}>{displayTime(event.time)}</span>
              <span className={`agent-tag tone-${eventTone(event)}`}>{event.source}</span>
              <span className="feed-text"><strong>{event.name}</strong><small>{event.reasoning}</small></span>
              <span className="feed-meta">
                <span className={`operation operation-feed tone-${eventTone(event)}`}>{eventLabel(event)}</span>
                {event.confidence > 0 && <span className="feed-conf">{Math.round(event.confidence * 100)}%</span>}
                <span className="feed-seq">#{event.seq}</span>
              </span>
            </div>)}
          </div>
        </div>

        <div className="panel board-panel">
          <div className="panel-heading compact">
            <div><span className="section-index">02</span><div><h2>Agent board</h2><p>Latest recorded event by actor</p></div></div>
          </div>
          <div className="agent-board">
            {latestByActor.map(([actor, event]) => <div className="board-row" key={actor}>
              <span className={`state-dot ${event.status === "active" ? "working" : ""}`} />
              <div className="board-copy">
                <strong>{actor}</strong>
                <span title={event.reasoning}>{event.reasoning || event.name}</span>
              </div>
              <span className="board-tag">SEQ {event.seq}</span>
            </div>)}
          </div>
        </div>
      </section>

      <section className="charts-row">
        <div className="panel chart-panel">
          <div className="panel-heading compact"><div><span className="section-index">03</span><div><h2>Ledger activity</h2><p>Recorded entries across the run timeline</p></div></div><span className="panel-stat">{throughput ? `${throughput.timedCount} TIMED` : "NO RANGE"}</span></div>
          <div className="chart-body">{throughput ? <ThroughputChart buckets={throughput.buckets} /> : <div className="chart-empty"><Icon name="clock" size={18} /><span>Insufficient timestamp range for throughput</span></div>}</div>
        </div>
        <div className="panel chart-panel">
          <div className="panel-heading compact"><div><span className="section-index">04</span><div><h2>Confidence spread</h2><p>Recorded confidence values only</p></div></div><span className="panel-stat">{confidence.count ? `${confidence.count} SCORED` : "NO SCORES"}</span></div>
          <div className="chart-body">{confidence.count ? <Histogram buckets={confidence.buckets} /> : <div className="chart-empty"><Icon name="target" size={18} /><span>No confidence data is available in the Event Ledger</span></div>}</div>
        </div>
        <div className="panel chart-panel">
          <div className="panel-heading compact"><div><span className="section-index">05</span><div><h2>Ledger event types</h2><p>Semantic categories across real entries</p></div></div><span className="panel-stat">{timeline.length} TOTAL</span></div>
          <div className="chart-body"><EventCategoryDonut categories={categories} /></div>
        </div>
      </section>
    </>}
  </div>;
}
