"use client";

import { useEffect, useRef, useState } from "react";
import { Icon } from "./icons";
import { agents } from "./agents-data";

type EventKind = "classify" | "gate_pass" | "gate_hold" | "ire" | "publish" | "relationship" | "duplicate" | "hr";
type LiveEvent = { id: number; time: string; agent: string; text: string; kind: EventKind; confidence: number | null };

const ciNames = [
  "pay-gw-lnx-03", "payments-db-01", "edge-lb-prod-02", "sap-app-eu-04", "fileshare-nyc-12",
  "mq-cluster-node-b", "vpn-conc-ams-01", "k8s-node-eu-17", "ora-listener-09", "win-print-ldn-04",
];
const ciClasses = ["Linux Server", "Windows Server", "Oracle Database", "Load Balancer", "Application Server", "Storage Volume"];

type Template = { agent: string; kind: EventKind; conf: [number, number] | null; make: (ci: string, cls: string, ci2: string) => string };
const templates: Template[] = [
  { agent: "Atlas", kind: "classify", conf: [.9, .99], make: (ci, cls) => `Classified ${ci} as ${cls}` },
  { agent: "Atlas", kind: "classify", conf: [.88, .97], make: ci => `Re-read ${ci}; taxonomy match confirmed on second pass` },
  { agent: "Sentry", kind: "gate_pass", conf: [.95, .99], make: ci => `Cleared ${ci} through the confidence gate` },
  { agent: "Sentry", kind: "gate_hold", conf: [.55, .8], make: ci => `Held ${ci} for human review — identity signals incomplete` },
  { agent: "Ledger", kind: "ire", conf: [.9, .99], make: ci => `Submitted ${ci} to IRE; matched on serial + FQDN` },
  { agent: "Ledger", kind: "publish", conf: [.92, .99], make: ci => `IRE accepted governed UPDATE for ${ci}` },
  { agent: "Weaver", kind: "relationship", conf: [.7, .95], make: (ci, _c, ci2) => `Inferred ${ci} → depends on → ${ci2}` },
  { agent: "Scout", kind: "duplicate", conf: [.8, .97], make: (ci, _c, ci2) => `Flagged probable duplicate pair ${ci} ↔ ${ci2}` },
  { agent: "Mara", kind: "hr", conf: null, make: () => `Spot-checked 12 recent decisions; calibration within tolerance` },
];

const seedEvents: LiveEvent[] = [
  { id: 1, time: "06:09:12", agent: "Ledger", text: "IRE accepted governed UPDATE for pay-gw-lnx-03", kind: "publish", confidence: .98 },
  { id: 2, time: "06:09:10", agent: "Sentry", text: "Cleared payments-db-01 through the confidence gate", kind: "gate_pass", confidence: .97 },
  { id: 3, time: "06:09:08", agent: "Atlas", text: "Classified edge-lb-prod-02 as Load Balancer", kind: "classify", confidence: .96 },
  { id: 4, time: "06:08:59", agent: "Sentry", text: "Held sap-app-eu-04 for human review — identity signals incomplete", kind: "gate_hold", confidence: .76 },
  { id: 5, time: "06:08:57", agent: "Scout", text: "Flagged probable duplicate pair fileshare-nyc-12 ↔ fs-nyc-012", kind: "duplicate", confidence: .93 },
];

const kindLabel: Record<EventKind, string> = {
  classify: "CLASSIFY", gate_pass: "GATE PASS", gate_hold: "GATE HOLD", ire: "IRE SUBMIT",
  publish: "PUBLISH", relationship: "EDGE", duplicate: "DUPLICATE", hr: "HR AUDIT",
};
const kindTone: Record<EventKind, string> = {
  classify: "lime", gate_pass: "green", gate_hold: "amber", ire: "green",
  publish: "lime", relationship: "green", duplicate: "amber", hr: "muted",
};

function pick<T>(list: T[]): T { return list[Math.floor(Math.random() * list.length)]; }

function Sparkline({ points, width = 84, height = 24 }: { points: number[]; width?: number; height?: number }) {
  const min = Math.min(...points), max = Math.max(...points);
  const span = max - min || 1;
  const coords = points.map((p, i) => `${(i / (points.length - 1)) * width},${height - 3 - ((p - min) / span) * (height - 6)}`).join(" ");
  return <svg className="sparkline" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true"><polyline points={coords} /></svg>;
}

function ThroughputChart({ ticks }: { ticks: number[] }) {
  const max = Math.max(...ticks, 3);
  return <svg className="throughput-chart" viewBox="0 0 300 110" preserveAspectRatio="none" role="img" aria-label="Decisions per tick over the last 30 ticks">
    {ticks.map((value, index) => {
      const h = (value / max) * 92;
      return <rect key={index} x={index * 10 + 1.5} y={104 - h} width={7} height={Math.max(h, 2)} className={index === ticks.length - 1 ? "bar current" : "bar"} />;
    })}
    <line x1="0" y1="104.5" x2="300" y2="104.5" className="axis" />
  </svg>;
}

function Histogram({ buckets }: { buckets: number[] }) {
  const max = Math.max(...buckets, 1);
  return <div className="histogram" role="img" aria-label="Distribution of decision confidence">
    <svg viewBox="0 0 300 110" preserveAspectRatio="none">
      {buckets.map((value, index) => {
        const h = (value / max) * 92;
        const tone = index >= 9 ? "lime" : index >= 7 ? "green" : index >= 5 ? "amber" : "coral";
        return <rect key={index} x={index * 30 + 3} y={104 - h} width={24} height={Math.max(h, 2)} className={`bar ${tone}`} />;
      })}
      <line x1="0" y1="104.5" x2="300" y2="104.5" className="axis" />
    </svg>
    <div className="histogram-scale"><span>50%</span><span>75%</span><span>95%</span><span>100%</span></div>
  </div>;
}

function OutcomeDonut({ auto, held, findings }: { auto: number; held: number; findings: number }) {
  const total = Math.max(auto + held + findings, 1);
  const r = 40, c = 2 * Math.PI * r;
  const segments = [
    { value: auto, label: "Auto-processed", cls: "lime" },
    { value: findings, label: "Findings", cls: "green" },
    { value: held, label: "Held for review", cls: "amber" },
  ];
  let offset = 0;
  return <div className="donut-wrap">
    <svg viewBox="0 0 110 110" role="img" aria-label="Share of decisions by outcome">
      {segments.map(seg => {
        const frac = seg.value / total;
        const el = <circle key={seg.label} cx="55" cy="55" r={r} className={`donut-seg ${seg.cls}`}
          strokeDasharray={`${frac * c} ${c}`} strokeDashoffset={-offset * c} transform="rotate(-90 55 55)" />;
        offset += frac;
        return el;
      })}
      <text x="55" y="52" className="donut-number">{total.toLocaleString()}</text>
      <text x="55" y="66" className="donut-caption">DECISIONS</text>
    </svg>
    <div className="donut-legend">
      {segments.map(seg => <span key={seg.label}><i className={`${seg.cls}-bg`} /> {seg.label} · {Math.round((seg.value / total) * 100)}%</span>)}
    </div>
  </div>;
}

export function LiveOpsView() {
  const [events, setEvents] = useState<LiveEvent[]>(seedEvents);
  const [ticks, setTicks] = useState<number[]>(() => [1, 2, 1, 1, 2, 1, 2, 2, 1, 1, 2, 1, 1, 2, 1, 2, 1, 1, 2, 1, 1, 2, 1, 2, 1, 1, 2, 1, 2, 1]);
  const [buckets, setBuckets] = useState<number[]>(() => [0, 0, 1, 1, 2, 3, 5, 9, 16, 27]);
  const [outcomes, setOutcomes] = useState({ auto: 1189, held: 17, findings: 42 });
  const [agentActivity, setAgentActivity] = useState<Record<string, { task: string; at: number }>>({});
  const [streaming, setStreaming] = useState(true);
  const [tickCount, setTickCount] = useState(0);
  const nextId = useRef(100);

  useEffect(() => {
    if (!streaming) return;
    const timer = window.setInterval(() => {
      const burst = Math.random() > .55 ? 2 : 1;
      const created: LiveEvent[] = [];
      for (let i = 0; i < burst; i++) {
        const template = pick(templates);
        const ci = pick(ciNames);
        let ci2 = pick(ciNames);
        if (ci2 === ci) ci2 = pick(ciNames.filter(name => name !== ci));
        const confidence = template.conf ? template.conf[0] + Math.random() * (template.conf[1] - template.conf[0]) : null;
        created.push({
          id: nextId.current++,
          time: new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }),
          agent: template.agent,
          text: template.make(ci, pick(ciClasses), ci2),
          kind: template.kind,
          confidence,
        });
      }
      setEvents(current => [...created, ...current].slice(0, 30));
      setTicks(current => [...current.slice(1), burst]);
      setTickCount(current => current + 1);
      setBuckets(current => {
        const next = [...current];
        for (const event of created) {
          if (event.confidence === null) continue;
          next[Math.min(9, Math.floor(((event.confidence - .5) / .5) * 10))] += 1;
        }
        return next;
      });
      setOutcomes(current => {
        const next = { ...current };
        for (const event of created) {
          if (event.kind === "gate_hold") next.held += 1;
          else if (event.kind === "relationship" || event.kind === "duplicate") next.findings += 1;
          else if (event.kind !== "hr") next.auto += 1;
        }
        return next;
      });
      setAgentActivity(current => {
        const next = { ...current };
        for (const event of created) next[event.agent] = { task: event.text, at: Date.now() };
        return next;
      });
    }, 1700);
    return () => window.clearInterval(timer);
  }, [streaming]);

  const perMinute = Math.round((ticks.reduce((sum, t) => sum + t, 0) / (ticks.length * 1.7)) * 60);
  const gateHoldRate = ((outcomes.held / Math.max(outcomes.auto + outcomes.held + outcomes.findings, 1)) * 100).toFixed(1);

  return <div className="page">
    <section className="page-heading">
      <div>
        <span className="eyebrow accent">LIVE OPS</span>
        <h1>Watch the agents think.</h1>
        <p>Every decision, streamed as it happens. Nothing here writes to the CMDB except through IRE.</p>
      </div>
      <div className="run-state">
        <span className={streaming ? "run-pulse" : "run-pulse paused"} />
        <div><small>AGENT STREAM</small><strong>{streaming ? "Streaming decisions" : "Stream paused"}</strong></div>
        <button className="play-button" onClick={() => setStreaming(value => !value)}>
          <Icon name={streaming ? "pause" : "play"} size={15} />{streaming ? "Pause" : "Resume"}
        </button>
      </div>
    </section>

    <section className="kpi-grid">
      <div className="kpi-card lime"><div className="kpi-top"><span>Decisions this run</span><span className="kpi-icon"><Icon name="bolt" size={17} /></span></div><strong>{(outcomes.auto + outcomes.held + outcomes.findings).toLocaleString()}</strong><div className="kpi-foot"><span>{streaming ? "streaming" : "paused"}</span><i /></div></div>
      <div className="kpi-card green"><div className="kpi-top"><span>Decisions / min</span><span className="kpi-icon"><Icon name="pulse" size={17} /></span></div><strong>{perMinute}</strong><div className="kpi-foot"><span>rolling 50s window</span><i /></div></div>
      <div className="kpi-card amber"><div className="kpi-top"><span>Gate hold rate</span><span className="kpi-icon"><Icon name="shield" size={17} /></span></div><strong>{gateHoldRate}%</strong><div className="kpi-foot"><span>{outcomes.held} held for humans</span><i /></div></div>
      <div className="kpi-card coral"><div className="kpi-top"><span>Live ticks</span><span className="kpi-icon"><Icon name="clock" size={17} /></span></div><strong>{tickCount}</strong><div className="kpi-foot"><span>since page open</span><i /></div></div>
    </section>

    <section className="live-grid">
      <div className="panel feed-panel">
        <div className="panel-heading compact">
          <div><span className="section-index">01</span><div><h2>Decision stream</h2><p>What each agent is doing, right now</p></div></div>
          <span className="panel-stat"><i className="live-dot" /> {streaming ? "LIVE" : "PAUSED"}</span>
        </div>
        <div className="feed" aria-live="polite">
          {events.map(event => <div className="feed-item" key={event.id}>
            <span className="feed-time">{event.time}</span>
            <span className={`agent-tag tone-${kindTone[event.kind]}`}>{event.agent}</span>
            <span className="feed-text">{event.text}</span>
            <span className="feed-meta">
              <span className={`operation operation-feed tone-${kindTone[event.kind]}`}>{kindLabel[event.kind]}</span>
              {event.confidence !== null && <span className="feed-conf">{Math.round(event.confidence * 100)}%</span>}
            </span>
          </div>)}
        </div>
      </div>

      <div className="panel board-panel">
        <div className="panel-heading compact">
          <div><span className="section-index">02</span><div><h2>Agent board</h2><p>Who is on shift</p></div></div>
        </div>
        <div className="agent-board">
          {agents.map(agent => {
            const activity = agentActivity[agent.codename];
            const working = activity && Date.now() - activity.at < 6000;
            return <div className="board-row" key={agent.id}>
              <span className={`state-dot ${working ? "working" : "idle"}`} />
              <div className="board-copy">
                <strong>{agent.codename}</strong>
                <span>{working ? activity.task : agent.status === "coaching" ? "Throttled — retraining in progress" : "Waiting for the next record…"}</span>
              </div>
              <Sparkline points={agent.spark} />
            </div>;
          })}
          <div className="board-row hr-row">
            <span className="state-dot working" />
            <div className="board-copy"><strong>Mara</strong><span>Auditing the other five — see Agent HR</span></div>
            <span className="board-tag">HR</span>
          </div>
        </div>
      </div>
    </section>

    <section className="charts-row">
      <div className="panel chart-panel">
        <div className="panel-heading compact"><div><span className="section-index">03</span><div><h2>Throughput</h2><p>Decisions per tick, last 30 ticks</p></div></div><span className="panel-stat">{perMinute}/MIN</span></div>
        <div className="chart-body"><ThroughputChart ticks={ticks} /></div>
      </div>
      <div className="panel chart-panel">
        <div className="panel-heading compact"><div><span className="section-index">04</span><div><h2>Confidence spread</h2><p>Where decisions land, 50–100%</p></div></div><span className="panel-stat">GATE AT 95%</span></div>
        <div className="chart-body"><Histogram buckets={buckets} /></div>
      </div>
      <div className="panel chart-panel">
        <div className="panel-heading compact"><div><span className="section-index">05</span><div><h2>Outcomes</h2><p>Where the work ends up</p></div></div><span className="panel-stat">GOVERNED</span></div>
        <div className="chart-body"><OutcomeDonut auto={outcomes.auto} held={outcomes.held} findings={outcomes.findings} /></div>
      </div>
    </section>
  </div>;
}
