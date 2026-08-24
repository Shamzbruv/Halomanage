import Link from "next/link";
import { Brand } from "@/components/Brand";
import { Icon, type IconName } from "@/components/Icon";

const features: Array<{ icon: IconName; title: string; body: string; tone: string }> = [
  { icon: "people", title: "One employee record", body: "A complete, effective-dated history from first day through every role, document, review, and change.", tone: "feature-mint" },
  { icon: "leave", title: "Time & leave", body: "Trusted clock events, configurable leave policies, clean balances, and approval routes that match your organization.", tone: "feature-sun" },
  { icon: "onboarding", title: "Onboarding that moves", body: "Build reusable checklists with owners, due dates, dependencies, evidence, and real-time completion tracking.", tone: "feature-coral" },
  { icon: "performance", title: "Useful performance cycles", body: "Run probation, quarterly, annual, or custom checkpoints without forcing every team into one review ritual.", tone: "feature-lilac" },
  { icon: "document", title: "A secure document home", body: "Versioned contracts, policies, certificates, acknowledgements, and expiring-item alerts with precise visibility.", tone: "feature-mint" },
  { icon: "payroll", title: "Pay records, connected", body: "Import finalized payroll results for employee access and reconciliation—without turning HR software into a payroll engine.", tone: "feature-sun" },
];

const steps = [
  { number: "01", title: "Create your workspace", body: "Organization owners set up a secure HR workspace and become its first administrator." },
  { number: "02", title: "Shape it around your team", body: "Add departments, locations, positions, leave policies, and the approval routes you already use." },
  { number: "03", title: "Invite your people", body: "Employee accounts are invitation-only, linked to the HR record you created for them—never open to strangers." },
];

function ProductPreview() {
  return (
    <div className="landing-product" aria-label="Halomanage dashboard preview">
      <div className="landing-product-bar">
        <span /><span /><span />
        <small>halomanage.app</small>
      </div>
      <div className="landing-product-body">
        <aside>
          <Brand href="" inverse compact />
          {["dashboard", "people", "leave", "onboarding", "performance"].map((item, index) => (
            <div className={index === 0 ? "active" : ""} key={item}>
              <Icon name={item as IconName} size={15} /><span />
            </div>
          ))}
        </aside>
        <section>
          <div className="preview-heading"><div><small>MONDAY, AUGUST 24</small><strong>Good morning, Maya</strong></div><span className="preview-avatar">MW</span></div>
          <div className="preview-stats">
            <div><small>Total people</small><strong>84</strong><em>+3 this month</em></div>
            <div><small>Working today</small><strong>71</strong><em>84% attendance</em></div>
            <div><small>Needs attention</small><strong>6</strong><em>2 overdue</em></div>
          </div>
          <div className="preview-grid">
            <div className="preview-chart">
              <div><strong>Team availability</strong><small>Today</small></div>
              <div className="preview-bars"><i style={{ height: "54%" }} /><i style={{ height: "78%" }} /><i style={{ height: "66%" }} /><i style={{ height: "88%" }} /><i style={{ height: "72%" }} /><i style={{ height: "92%" }} /><i style={{ height: "82%" }} /></div>
              <div className="preview-axis"><span>M</span><span>T</span><span>W</span><span>T</span><span>F</span><span>S</span><span>S</span></div>
            </div>
            <div className="preview-actions">
              <strong>Next actions</strong>
              {["Approve 2 leave requests", "Review onboarding", "Sign policy update"].map((item, index) => (
                <div key={item}><span className={`preview-dot dot-${index}`}><Icon name={index === 0 ? "leave" : index === 1 ? "onboarding" : "document"} size={12} /></span><small>{item}</small></div>
              ))}
            </div>
          </div>
        </section>
      </div>
    </div>
  );
}

export default function LandingPage() {
  return (
    <div className="landing-page">
      <header className="landing-nav">
        <div className="landing-container landing-nav-inner">
          <Brand />
          <nav aria-label="Public navigation">
            <a href="#platform">Platform</a>
            <a href="#how-it-works">How it works</a>
            <a href="#security">Security</a>
          </nav>
          <div className="landing-nav-actions">
            <Link href="/login" className="landing-signin">Sign in</Link>
            <Link href="/signup" className="btn-primary">Create workspace <Icon name="arrow-right" size={16} /></Link>
          </div>
        </div>
      </header>

      <main>
        <section className="landing-hero">
          <div className="landing-orbit orbit-one" /><div className="landing-orbit orbit-two" />
          <div className="landing-container landing-hero-grid">
            <div className="landing-hero-copy">
              <div className="landing-kicker"><Icon name="spark" size={15} /> Built for the whole employee journey</div>
              <h1>People operations, <em>beautifully organized.</em></h1>
              <p>Halomanage brings employee records, time, leave, onboarding, performance, documents, and pay records into one secure workspace your team can actually enjoy using.</p>
              <div className="landing-hero-actions">
                <Link href="/signup" className="btn-primary landing-cta">Create your workspace <Icon name="arrow-right" size={17} /></Link>
                <Link href="/login" className="btn-secondary landing-cta">Sign in to your account</Link>
              </div>
              <div className="landing-hero-note">
                <span><Icon name="check" size={14} /> No payroll engine</span>
                <span><Icon name="check" size={14} /> Invitation-only employees</span>
                <span><Icon name="check" size={14} /> Supabase-secured</span>
              </div>
            </div>
            <div className="landing-visual"><ProductPreview /><div className="landing-float-card"><span><Icon name="check" size={15} /></span><div><strong>Onboarding complete</strong><small>Jordan Miller · 2 min ago</small></div></div></div>
          </div>
        </section>

        <section className="landing-proof">
          <div className="landing-container">
            <p>One calm workspace for every kind of people work</p>
            <div><span>Employee records</span><span>Attendance</span><span>Leave</span><span>Onboarding</span><span>Performance</span><span>Documents</span><span>Pay records</span></div>
          </div>
        </section>

        <section className="landing-section" id="platform">
          <div className="landing-container">
            <div className="landing-section-heading">
              <div><span className="eyebrow">The connected HR workspace</span><h2>Everything your people need.<br /><em>Nothing they don&apos;t.</em></h2></div>
              <p>Each module understands the same employee, reporting structure, permissions, and workflow—so work moves forward without duplicate entry or disconnected spreadsheets.</p>
            </div>
            <div className="landing-feature-grid">
              {features.map((feature) => (
                <article className={feature.tone} key={feature.title}>
                  <span className="landing-feature-icon"><Icon name={feature.icon} /></span>
                  <h3>{feature.title}</h3>
                  <p>{feature.body}</p>
                  <span className="landing-feature-link">Explore the workflow <Icon name="arrow-right" size={15} /></span>
                </article>
              ))}
            </div>
          </div>
        </section>

        <section className="landing-flow" id="how-it-works">
          <div className="landing-container landing-flow-grid">
            <div className="landing-flow-copy"><span className="eyebrow">A clear way in</span><h2>Start as an organization.<br /><em>Join as a person.</em></h2><p>Account creation is deliberate and easy to understand. Organization owners create the workspace. Employees join only through a secure invitation that connects them to their existing HR record.</p><Link href="/signup" className="btn-primary landing-cta">Set up Halomanage <Icon name="arrow-right" size={17} /></Link></div>
            <div className="landing-steps">
              {steps.map((step) => <div key={step.number}><span>{step.number}</span><div><h3>{step.title}</h3><p>{step.body}</p></div></div>)}
            </div>
          </div>
        </section>

        <section className="landing-security" id="security">
          <div className="landing-container landing-security-grid">
            <div className="security-visual"><div className="security-ring ring-a" /><div className="security-ring ring-b" /><span><Icon name="shield" size={50} /></span><div className="security-pill pill-one"><i /> Employee data isolated</div><div className="security-pill pill-two"><i /> Access checked at the database</div></div>
            <div className="landing-security-copy"><span className="eyebrow">Security is the foundation</span><h2>The right access,<br /><em>down to each row.</em></h2><p>Halomanage uses PostgreSQL Row Level Security as the real authorization boundary. Employees see themselves, supervisors see their scope, and sensitive pay or private information stays separately permissioned.</p><ul><li><Icon name="check" size={16} /> Organization-aware tenant isolation</li><li><Icon name="check" size={16} /> Role + relationship + scope permissions</li><li><Icon name="check" size={16} /> Private document storage and auditable actions</li></ul></div>
          </div>
        </section>

        <section className="landing-final">
          <div className="landing-container landing-final-card"><div><span className="eyebrow">Ready when you are</span><h2>Give your people work<br />a better home.</h2><p>Create the workspace, shape your processes, then invite your team.</p></div><div><Link href="/signup" className="btn-primary landing-cta">Create your workspace <Icon name="arrow-right" size={17} /></Link><Link href="/login">Already have an account? Sign in</Link></div></div>
        </section>
      </main>

      <footer className="landing-footer"><div className="landing-container"><Brand /><p>Employee lifecycle management without a payroll engine.</p><span>© {new Date().getFullYear()} Halomanage</span></div></footer>
    </div>
  );
}
