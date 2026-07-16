"use client";

import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { agents, hrFeed, maraDuties, type Agent, type AgentStanding } from "./agents-data";

const standingLabel: Record<AgentStanding, string> = { exemplary: "EXEMPLARY", solid: "SOLID", watch: "ON WATCH" };

function SkillRadar({ skills }: { skills: Agent["skills"] }) {
  const cx = 165, cy = 104, radius = 76;
  const point = (index: number, value: number) => {
    const angle = (index / skills.length) * Math.PI * 2 - Math.PI / 2;
    return [cx + Math.cos(angle) * radius * (value / 100), cy + Math.sin(angle) * radius * (value / 100)] as const;
  };
  const ring = (fraction: number) => skills.map((_, i) => point(i, fraction * 100).join(",")).join(" ");
  return <svg className="radar" viewBox="0 0 330 212" role="img" aria-label="Competency radar">
    {[.35, .6, .85].map(fraction => <polygon key={fraction} points={ring(fraction)} className="radar-ring" />)}
    {skills.map((_, i) => { const [x, y] = point(i, 100); return <line key={i} x1={cx} y1={cy} x2={x} y2={y} className="radar-axis" />; })}
    <polygon points={skills.map((skill, i) => point(i, skill.value).join(",")).join(" ")} className="radar-shape" />
    {skills.map((skill, i) => { const [x, y] = point(i, skill.value); return <circle key={skill.label} cx={x} cy={y} r="2.5" className="radar-dot" />; })}
    {skills.map((skill, i) => {
      const [x, y] = point(i, 120);
      const anchor = Math.abs(x - cx) < 12 ? "middle" : x < cx ? "end" : "start";
      return <text key={skill.label} x={x} y={y + 3} className="radar-label" textAnchor={anchor}>{skill.label.toUpperCase()} {skill.value}</text>;
    })}
  </svg>;
}

function WorkloadBars() {
  const max = Math.max(...agents.map(agent => agent.tasksToday));
  return <div className="load-bars" role="img" aria-label="Tasks handled today per agent">
    {agents.map(agent => <div className="load-row" key={agent.id}>
      <span className="load-name">{agent.codename}</span>
      <div className="load-track"><i className={agent.standing === "watch" ? "amber-fill" : ""} style={{ width: `${(agent.tasksToday / max) * 100}%` }} /></div>
      <span className="load-count">{agent.tasksToday.toLocaleString()}</span>
    </div>)}
  </div>;
}

export function AgentHrView() {
  const [selected, setSelected] = useState<Agent>(agents[0]);
  const [dutyIndex, setDutyIndex] = useState(0);
  const [hrMessage, setHrMessage] = useState("");

  useEffect(() => {
    const timer = window.setInterval(() => setDutyIndex(index => (index + 1) % maraDuties.length), 3400);
    return () => window.clearInterval(timer);
  }, []);

  const avgAccuracy = (agents.reduce((sum, agent) => sum + agent.accuracy, 0) / agents.length).toFixed(1);
  const coaching = agents.filter(agent => agent.status === "coaching").length;

  function act(action: string) {
    setHrMessage(`${action} for ${selected.codename} — drafted by Mara and logged to the event ledger. Nothing changes until a human approves it.`);
  }

  return <div className="page">
    <section className="page-heading">
      <div>
        <span className="eyebrow accent">AGENT HR</span>
        <h1>Someone has to manage the agents.</h1>
        <p>Mara reviews, coaches, and — when needed — benches the AI workforce. Her actions are proposals; humans sign off.</p>
      </div>
      <div className="persona-card">
        <span className="persona-mark"><Icon name="heart" size={17} /></span>
        <div>
          <small>MARA · HR AGENT</small>
          <strong className="persona-duty">{maraDuties[dutyIndex]}</strong>
          <span>On shift 142 days · reports to you</span>
        </div>
      </div>
    </section>

    <section className="kpi-grid">
      <div className="kpi-card lime"><div className="kpi-top"><span>Agents managed</span><span className="kpi-icon"><Icon name="users" size={17} /></span></div><strong>{agents.length}</strong><div className="kpi-foot"><span>+ Mara herself</span><i /></div></div>
      <div className="kpi-card green"><div className="kpi-top"><span>Avg accuracy</span><span className="kpi-icon"><Icon name="target" size={17} /></span></div><strong>{avgAccuracy}%</strong><div className="kpi-foot"><span>across the team</span><i /></div></div>
      <div className="kpi-card amber"><div className="kpi-top"><span>On coaching plan</span><span className="kpi-icon"><Icon name="book" size={17} /></span></div><strong>{coaching}</strong><div className="kpi-foot"><span>Weaver · retraining</span><i /></div></div>
      <div className="kpi-card coral"><div className="kpi-top"><span>Reviews this cycle</span><span className="kpi-icon"><Icon name="award" size={17} /></span></div><strong>{agents.length}</strong><div className="kpi-foot"><span>cycle 07 complete</span><i /></div></div>
    </section>

    <section className="panel roster-panel">
      <div className="panel-heading">
        <div><span className="section-index">01</span><div><h2>The roster</h2><p>Click an agent to open Mara's latest review.</p></div></div>
        <span className="panel-stat">CYCLE 07 · ALL REVIEWED</span>
      </div>
      <div className="roster-grid">
        {agents.map(agent => <button key={agent.id} className={`roster-card ${selected.id === agent.id ? "selected" : ""}`} onClick={() => setSelected(agent)}>
          <div className="roster-top">
            <strong>{agent.codename}</strong>
            <span className={`standing standing-${agent.standing}`}>{standingLabel[agent.standing]}</span>
          </div>
          <span className="roster-role">{agent.role}</span>
          <p>{agent.focus}</p>
          <div className="roster-foot">
            <span>{agent.accuracy}% acc</span>
            <span>{agent.tasksToday.toLocaleString()} today</span>
            <span>{agent.tenure}</span>
          </div>
        </button>)}
      </div>
    </section>

    <section className="hr-layout">
      <div className="panel review-panel">
        <div className="panel-heading">
          <div><span className="section-index">02</span><div><h2>Performance review · {selected.codename}</h2><p>{selected.review.cycle} · written by Mara</p></div></div>
          <span className={`standing standing-${selected.standing}`}>{standingLabel[selected.standing]}</span>
        </div>
        <div className="review-body">
          <SkillRadar skills={selected.skills} />
          <div className="review-copy">
            <p className="review-summary">{selected.review.summary}</p>
            <div className="review-lists">
              <div>
                <small className="lime-text">WHAT WENT WELL</small>
                <ul>{selected.review.wins.map(win => <li key={win}>{win}</li>)}</ul>
              </div>
              <div>
                <small className="amber-text">GROWTH AREAS</small>
                <ul>{selected.review.growth.map(item => <li key={item}>{item}</li>)}</ul>
              </div>
            </div>
            {hrMessage && <div className="action-message"><Icon name="check" size={16} />{hrMessage}</div>}
            <div className="hr-actions">
              <button className="ghost-button" onClick={() => act("Commendation")}><Icon name="award" size={15} /> Commend</button>
              <button className="ghost-button" onClick={() => act("Recalibration 1:1")}><Icon name="target" size={15} /> Recalibrate</button>
              <button className="ghost-button" onClick={() => act("Bench proposal")}><Icon name="pause" size={15} /> Bench</button>
            </div>
          </div>
        </div>
      </div>

      <div className="hr-side">
        <div className="panel workload-panel">
          <div className="panel-heading compact"><div><span className="section-index">03</span><div><h2>Workload today</h2><p>Tasks handled per agent</p></div></div></div>
          <WorkloadBars />
        </div>
        <div className="panel hrfeed-panel">
          <div className="panel-heading compact"><div><span className="section-index">04</span><div><h2>Mara's day</h2><p>Recent HR actions</p></div></div></div>
          <div className="hr-feed">
            {hrFeed.map(item => <div className="hr-feed-item" key={item.text}>
              <span className={`hr-feed-icon tone-${item.tone}`}><Icon name={item.icon} size={14} /></span>
              <div><span className="hr-feed-time">{item.time}</span><p>{item.text}</p></div>
            </div>)}
          </div>
        </div>
      </div>
    </section>
  </div>;
}
