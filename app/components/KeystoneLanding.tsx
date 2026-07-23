"use client";

import Link from "next/link";
import { useEffect, useState } from "react";
import "../landing.css";

function Lotus({ size = 48, glow = false }: { size?: number; glow?: boolean }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      aria-hidden="true"
      style={glow ? { filter: "drop-shadow(0 0 18px rgba(199,243,77,.45))" } : undefined}
    >
      {[-52, -26, 0, 26, 52].map((a) => (
        <path
          key={a}
          d="M12 17.4 C 9 13.4 9.4 8.2 12 4.6 C 14.6 8.2 15 13.4 12 17.4 Z"
          fill="rgba(199, 243, 77, .13)"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinejoin="round"
          transform={`rotate(${a} 12 17.4)`}
        />
      ))}
      <path
        d="M6 17.2 Q 12 20.6 18 17.2"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        opacity=".6"
      />
    </svg>
  );
}

const STAGES = [
  { label: "Stage", desc: "Import & normalize source data" },
  { label: "Comprehend", desc: "AI classifies every CI" },
  { label: "Prioritize", desc: "Rank fixes by CMDB impact" },
  { label: "Remediate", desc: "Execute through ServiceNow IRE" },
  { label: "Verify", desc: "Correlate & confirm outcomes" },
];

const PRINCIPLES = [
  { icon: "🔒", title: "Governed by design", desc: "Every write goes through IRE. No direct CMDB mutations. Full audit trail on every action." },
  { icon: "🧠", title: "AI-assisted, human-approved", desc: "Agent classifies and prioritizes. Humans review evidence and authorize execution." },
  { icon: "📊", title: "Evidence-first", desc: "Every decision carries provenance, confidence scores, and reasoning you can inspect." },
  { icon: "⚡", title: "Vercel-deployable", desc: "Runs as a Next.js app. Works with demo data immediately; connect ServiceNow when ready." },
];

const STATS = [
  { value: "7", label: "Pipeline stages" },
  { value: "IRE", label: "Only write path" },
  { value: "100%", label: "Audit coverage" },
  { value: "0", label: "Direct CMDB writes" },
];

export default function KeystoneLanding() {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  return (
    <div className="landing-root">
      {/* Ambient background */}
      <div className="landing-bg" aria-hidden="true">
        <div className="landing-bg-orb landing-bg-orb-1" />
        <div className="landing-bg-orb landing-bg-orb-2" />
        <div className="landing-bg-grid" />
      </div>

      {/* Nav */}
      <nav className="landing-nav">
        <div className="landing-nav-brand">
          <span style={{ color: "var(--lime)" }}><Lotus size={26} /></span>
          <strong>Keystone</strong>
        </div>
        <div className="landing-nav-links">
          <Link href="/control-plane" className="ghost-button" style={{ height: 36 }}>Control Plane</Link>
          <Link href="/ai-usage" className="ghost-button" style={{ height: 36 }}>AI Usage</Link>
        </div>
      </nav>

      {/* Hero */}
      <section className={`landing-hero-new ${mounted ? "visible" : ""}`}>
        <div className="landing-hero-badge">
          <span className="landing-hero-dot" />
          THE DOT WALKERS
        </div>

        <div className="landing-hero-lotus" aria-hidden="true">
          <Lotus size={120} glow />
        </div>

        <h1 className="landing-hero-title">
          Keystone
        </h1>
        <p className="landing-hero-sub">
          Move infrastructure data into your ServiceNow CMDB without losing control.
          Every action is evidenced, approved, and verified through IRE.
        </p>

        <div className="landing-hero-actions">
          <Link href="/control-plane" className="primary-button" style={{ minHeight: 48, padding: "0 28px", fontSize: 13 }}>
            Open Control Plane →
          </Link>
        </div>
      </section>

      {/* Stats strip */}
      <section className={`landing-stats ${mounted ? "visible" : ""}`}>
        {STATS.map((s) => (
          <div key={s.label} className="landing-stat">
            <strong>{s.value}</strong>
            <span>{s.label}</span>
          </div>
        ))}
      </section>

      {/* Pipeline */}
      <section className={`landing-section ${mounted ? "visible" : ""}`}>
        <div className="landing-section-head">
          <span className="eyebrow accent">MIGRATION LIFECYCLE</span>
          <h2>Five stages. One governed pipeline.</h2>
          <p>Data flows through a deterministic sequence — from raw import to verified CMDB state.</p>
        </div>

        <div className="landing-pipeline">
          {STAGES.map((s, i) => (
            <div key={s.label} className="landing-pipeline-stage">
              <div className="landing-pipeline-num">{String(i + 1).padStart(2, "0")}</div>
              <strong>{s.label}</strong>
              <span>{s.desc}</span>
              {i < STAGES.length - 1 && <div className="landing-pipeline-connector" aria-hidden="true" />}
            </div>
          ))}
        </div>
      </section>

      {/* Principles */}
      <section className={`landing-section ${mounted ? "visible" : ""}`}>
        <div className="landing-section-head">
          <span className="eyebrow accent">DESIGN PRINCIPLES</span>
          <h2>Built for trust, not speed.</h2>
          <p>Keystone treats your CMDB as critical infrastructure — because it is.</p>
        </div>

        <div className="landing-principles">
          {PRINCIPLES.map((p) => (
            <div key={p.title} className="landing-principle-card">
              <span className="landing-principle-icon">{p.icon}</span>
              <strong>{p.title}</strong>
              <p>{p.desc}</p>
            </div>
          ))}
        </div>
      </section>

      {/* Entry points */}
      <section className={`landing-section ${mounted ? "visible" : ""}`}>
        <div className="landing-section-head">
          <span className="eyebrow accent">GET STARTED</span>
          <h2>Two views, one truth.</h2>
        </div>

        <div className="landing-entries">
          <Link href="/control-plane" className="landing-entry">
            <div className="landing-entry-num">01</div>
            <div className="landing-entry-body">
              <strong>Migration Control Plane</strong>
              <p>Import data, follow migration runs, review agent evidence, authorize governed work and verify IRE outcomes.</p>
            </div>
            <span className="landing-entry-arrow">→</span>
          </Link>
          <Link href="/ai-usage" className="landing-entry">
            <div className="landing-entry-num">02</div>
            <div className="landing-entry-body">
              <strong>AI Usage Telemetry</strong>
              <p>Inspect model calls, phases, latency and token telemetry for the active migration run.</p>
            </div>
            <span className="landing-entry-arrow">→</span>
          </Link>
        </div>
      </section>

      {/* Footer */}
      <footer className="landing-footer">
        <div className="landing-footer-brand">
          <span style={{ color: "var(--lime)" }}><Lotus size={20} /></span>
          <span>Keystone</span>
        </div>
        <p>ServiceNow owns execution. IRE is the only CMDB write path. Every outcome is correlated and verified.</p>
        <small>© {new Date().getFullYear()} The Dot Walkers</small>
      </footer>
    </div>
  );
}
