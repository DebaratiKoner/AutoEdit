import { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../auth/Auth';
import { BrandLogo } from './BrandLogo';

const capabilities = [
  {
    icon: 'play',
    tag: 'Core Engine',
    title: 'Automated Video Editing',
    detail: 'AI scene detection, transcript-aware trims, and export-ready timeline assembly from a single production command.',
    tone: 'green',
  },
  {
    icon: 'wand',
    tag: 'GPT-4o / Whisper',
    title: 'Script Segmentation',
    detail: 'Voice, caption, and prompt intent are aligned into editable moments for fast post-production decisions.',
    tone: 'blue',
  },
  {
    icon: 'grid',
    tag: 'Wav2Vec 2.0',
    title: 'Subtitle Sync Engine',
    detail: 'Word-level timing keeps captions locked to dialogue while preserving clean editor handoff.',
    tone: 'amber',
  },
  {
    icon: 'diamond',
    tag: 'CogVideoX + Pixabay',
    title: 'Asset Hybrid Fallback',
    detail: 'B-roll and visual fallback sourcing keeps edits moving when local media needs extra coverage.',
    tone: 'green',
  },
];

const pipelineNodes = [
  {
    step: 'M0',
    title: 'Ingestion',
    subtitle: 'Raw Asset Intake',
    status: 'Awaiting Input',
    confidence: '--',
    detail:
      'PRISM ingests raw footage via secure upload or CDN pull. Format validation, codec fingerprinting, and metadata extraction run in parallel across distributed workers.',
    specs: [
      ['Format', 'MP4 / MOV / MKV'],
      ['Resolution', '4K UHD'],
      ['Bitrate', '85 Mbps'],
      ['Duration', '12:34 mm:ss'],
    ],
  },
  {
    step: 'M0-M1',
    title: 'AI Scene Segmentation',
    subtitle: 'CLIP + Whisper Analysis',
    status: 'Awaiting Input',
    confidence: '--',
    detail:
      'The engine maps speech, scene changes, silence, visual action, and prompt instructions into clean candidate edits.',
    specs: [
      ['Model', 'Whisper Large'],
      ['Scene Pass', 'CLIP Score'],
      ['Cut Mode', 'Auto Trim'],
      ['Latency', '< 5 min'],
    ],
  },
  {
    step: 'M1',
    title: 'PRISM Quality Gate',
    subtitle: 'Autonomous Scoring Layer',
    status: 'Awaiting Input',
    confidence: '--',
    detail:
      'Each candidate cut is scored against confidence, pacing, subtitle alignment, and asset availability before export.',
    specs: [
      ['Threshold', '0.90'],
      ['Scoring', 'Multi-pass'],
      ['Workers', '3 Active'],
      ['Queue', 'Parallel'],
    ],
  },
  {
    step: 'M1-Output',
    title: 'HITL Refinement Output',
    subtitle: 'Human-in-the-Loop Delivery',
    status: 'Awaiting Input',
    confidence: '--',
    detail:
      'The final edit opens in a timeline that preserves human control for naming clips, replacing assets, and exporting deliverables.',
    specs: [
      ['Output', 'Editor Timeline'],
      ['Captions', 'Synced'],
      ['Assets', 'Resolved'],
      ['Export', 'Whole / Clips'],
    ],
  },
];

const metrics = [
  ['◎', '60-80%', 'Manual Effort Eliminated', 'Autonomous AI replaces repetitive cut decisions, sync work, and export queueing.', 'green'],
  ['◌', '<5 min', 'Raw Footage to Polished Video', 'Down from 3-6 hours of professional editing per project.', 'blue'],
  ['↑', '2-3x', 'Output Capacity Increase', 'Teams produce more content at the same headcount with zero quality compromise.', 'amber'],
];

const jobs = [
  ['product-launch-v3.mp4', 'Scene Segmentation', '99%', 'blue'],
  ['brand-reel-raw.mov', 'PRISM Gate Scoring', '99%', 'amber'],
  ['webinar-recording.mkv', 'Subtitle Sync', '99%', 'green'],
];

const completed = [
  ['q1-campaign-cut.mp4', '18:32 -> 04:11', '77% saved'],
  ['tutorial-series-ep4.mov', '42:07 -> 09:53', '76% saved'],
  ['social-clips-raw.mp4', '08:45 -> 01:58', '77% saved'],
];

const scrollToSection = (id: string) => {
  document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
};

function CapabilityIcon({ name }: { name: string }) {
  if (name === 'play') return <span aria-hidden="true">▶</span>;
  if (name === 'wand') return <span aria-hidden="true">⌁</span>;
  if (name === 'grid') return <span aria-hidden="true">▦</span>;
  return <BrandLogo size="sm" animated={false} />;
}

export function Dashboard() {
  const navigate = useNavigate();
  const { isAuthenticated } = useAuth();
  const [activeFeature, setActiveFeature] = useState(0);
  const [activeNode, setActiveNode] = useState(0);
  const node = pipelineNodes[activeNode];

  const launchTarget = useMemo(() => (isAuthenticated ? '/upload' : '/auth?mode=signup'), [isAuthenticated]);

  return (
    <main className="dashboard-screen ae-page">
      <header className="ae-topbar">
        <button className="ae-brand" onClick={() => scrollToSection('hero')} aria-label="AutoEdit home">
          <BrandLogo size="sm" animated />
          <span>Auto<span>Edit</span></span>
        </button>
        <nav className="ae-topnav" aria-label="Primary navigation">
          <button onClick={() => scrollToSection('features')}>Features</button>
          <button onClick={() => scrollToSection('pipeline')}>Pipeline</button>
          <button onClick={() => scrollToSection('metrics')}>Metrics</button>
          <button onClick={() => scrollToSection('enterprise-cta')}>Enterprise</button>
          <span className="ae-status-dot">Engine Online</span>
          <button className="ae-primary-button" onClick={() => navigate(launchTarget)}>Launch App</button>
        </nav>
      </header>

      <section id="hero" className="dashboard-hero">
        <div className="dashboard-hero-copy">
          <p className="ae-kicker">PRISM Framework - v2.4.1</p>
          <h1>
            Autonomous Video
            <span>Post-Production</span>
            in <em>&lt;5 Minutes</em>
          </h1>
          <p>
            From raw footage to broadcast-ready content - AutoEdit's AI pipeline handles scene segmentation,
            subtitle sync, B-roll sourcing, and precision cuts, so your content teams, marketing agencies,
            and enterprise studios can scale output without scaling headcount.
          </p>
          <div className="dashboard-actions">
            <button className="ae-primary-button" onClick={() => navigate(launchTarget)}>Start Free Trial</button>
            <button className="ae-ghost-button" onClick={() => scrollToSection('pipeline')}>View Pipeline</button>
          </div>
        </div>

        <aside className="engine-card">
          <div className="engine-card-head">
            <span className="ae-live-pill">Live</span>
            <strong>PRISM Engine - Active Session</strong>
            <small>Uptime 99.98% - 3 workers</small>
          </div>
          {[
            ['GPU Utilisation', '75%', 'green'],
            ['CLIP Inference', '91%', 'blue'],
            ['Export Queue', '35%', 'amber'],
          ].map(([label, value, tone]) => (
            <div className="ae-progress-row" key={label}>
              <span>{label}</span>
              <div><i className={`tone-${tone}`} style={{ width: value }} /></div>
              <b className={`tone-text-${tone}`}>{value}</b>
            </div>
          ))}
          <div className="job-list">
            <p>Active Processing Jobs</p>
            {jobs.map(([name, phase, value, tone]) => (
              <div className="job-row" key={name}>
                <span><b>{name}</b><small>{phase}</small></span>
                <strong className={`tone-text-${tone}`}>{value}</strong>
              </div>
            ))}
          </div>
          <div className="completed-list">
            <p>Recently Completed</p>
            {completed.map(([name, time, saved]) => (
              <div key={name}>
                <span>✓ {name}</span>
                <b>{time}</b>
                <strong>{saved}</strong>
              </div>
            ))}
          </div>
        </aside>
      </section>

      <section id="features" className="dashboard-panel feature-section">
        <div className="section-heading">
          <p className="ae-kicker">Core Capabilities</p>
          <h2>Built for Production. Designed for Scale.</h2>
          <span>Every component of AutoEdit is engineered for enterprise reliability - from ingest to export.</span>
        </div>

        <div className="feature-grid">
          {capabilities.map((feature, index) => (
            <button
              className={`feature-card feature-${feature.tone} ${activeFeature === index ? 'is-selected' : ''}`}
              key={feature.title}
              onClick={() => setActiveFeature(index)}
            >
              <span className="feature-icon"><CapabilityIcon name={feature.icon} /></span>
              <span>
                <small>{feature.tag}</small>
                <strong>{feature.title}</strong>
                <em>{feature.detail}</em>
              </span>
              <i aria-hidden="true">›</i>
            </button>
          ))}
        </div>
      </section>

      <section id="pipeline" className="dashboard-panel">
        <div className="section-heading">
          <p className="ae-kicker">Interactive Demo</p>
          <h2>PRISM Gate Validation Pipeline</h2>
          <span>Click through each processing node to simulate the M0-M1 autonomous quality gate sequence.</span>
        </div>

        <div className="pipeline-layout">
          <nav className="pipeline-steps" aria-label="Pipeline nodes">
            {pipelineNodes.map((item, index) => (
              <button
                className={`pipeline-step ${activeNode === index ? 'is-active' : ''}`}
                key={item.title}
                onClick={() => setActiveNode(index)}
              >
                <span className="pipeline-orb">{index === 0 ? '↑' : index === 1 ? '△' : index === 2 ? '⬡' : '✦'}</span>
                <span className="pipeline-copy">
                  <small>{item.step}</small>
                  <strong>{item.title}</strong>
                  <em>{item.subtitle}</em>
                  <b>{item.status}</b>
                </span>
                <span className="pipeline-confidence">{item.confidence}<small>conf.</small></span>
              </button>
            ))}
          </nav>

          <article className="pipeline-detail">
            <p className="ae-kicker">{node.step}</p>
            <h3>{node.title}</h3>
            <span>{node.subtitle}</span>
            <p>{node.detail}</p>
            <div className="spec-grid">
              {node.specs.map(([label, value]) => (
                <div key={label}><span>{label}</span><strong>{value}</strong></div>
              ))}
            </div>
            <label className="confidence-meter">
              <span>CLIP Confidence Score</span>
              <input type="range" min="0" max="100" defaultValue="90" aria-label="CLIP confidence score" />
              <small>Pass threshold: 0.9</small>
            </label>
            <div className="pipeline-actions">
              <button className="ae-primary-button" onClick={() => navigate(launchTarget)}>▶ Run Full Pipeline</button>
              <button className="ae-ghost-button" onClick={() => setActiveNode(0)}>↻ Reset</button>
            </div>
          </article>
        </div>
      </section>

      <section id="metrics" className="metrics-section">
        <div className="section-heading">
          <p className="ae-kicker amber">Enterprise Impact</p>
          <h2>Measurable Results. Immediate ROI.</h2>
          <span>AutoEdit doesn't just save time - it compounds efficiency across every project, sprint, and campaign.</span>
        </div>
        <div className="metrics-grid">
          {metrics.map(([icon, value, label, detail, tone]) => (
            <article className={`metric-card metric-${tone}`} key={label}>
              <span>{icon}</span>
              <strong>{value}</strong>
              <h3>{label}</h3>
              <p>{detail}</p>
            </article>
          ))}
        </div>
      </section>

      <section id="enterprise-cta" className="enterprise-cta">
        <div>
          <h2>Ready to automate your post-production?</h2>
          <p>Join 500+ studios already using AutoEdit to ship content 3x faster.</p>
        </div>
        <div className="dashboard-actions">
          <button className="ae-primary-button" onClick={() => navigate(launchTarget)}>▶ Start Free Trial</button>
          <button className="ae-ghost-button" onClick={() => navigate('/auth?mode=signup')}>Talk to Sales →</button>
        </div>
      </section>

      <footer className="dashboard-footer">
        <div className="footer-brand">
          <button className="ae-brand" onClick={() => scrollToSection('hero')} aria-label="Back to top">
            <BrandLogo size="sm" animated />
            <span>Auto<span>Edit</span></span>
          </button>
          <p>AI-Driven Autonomous Video Editing & Generation Engine. Built for content teams that demand speed without compromise.</p>
          <div className="footer-socials">
            {['𝕏', 'in', '⌂', '◉'].map((item) => <button key={item}>{item}</button>)}
          </div>
          <div className="footer-badges">
            {['SOC 2', 'GDPR', 'ISO 27001', 'CCPA'].map((item) => <span key={item}>{item}</span>)}
          </div>
        </div>
        {[
          ['Product', 'Features', 'Pipeline Overview', 'Pricing', 'Changelog'],
          ['Company', 'About', 'Blog', 'Careers', 'Press Kit'],
          ['Legal & Compliance', 'Privacy Policy', 'Terms of Service', 'SOC 2 Type II', 'GDPR', 'Open Source Licenses'],
          ['Developers', 'API Reference', 'SDK Documentation', 'Webhooks', 'Status Page'],
        ].map(([title, ...links]) => (
          <div className="footer-links" key={title}>
            <h3>{title}</h3>
            {links.map((link) => <button key={link}>{link}</button>)}
          </div>
        ))}
      </footer>

      <div className="tech-stack">
        <span>Technology Stack:</span>
        {['PRISM Framework v2.4.1', 'OpenAI Whisper v3 Large', 'Pixabay API 2026-04', 'Freesound API 2026-04', 'Remotion v4.0.460', 'CogVideoX 2b'].map((item) => (
          <b key={item}>{item}</b>
        ))}
      </div>

      <div className="copyright">
        <span>© 2026 AutoEdit Inc. All rights reserved. PRISM Framework is a proprietary AI pipeline.</span>
        <span>Privacy&nbsp;&nbsp;&nbsp; Terms&nbsp;&nbsp;&nbsp; Cookies&nbsp;&nbsp;&nbsp; Accessibility</span>
      </div>
    </main>
  );
}
