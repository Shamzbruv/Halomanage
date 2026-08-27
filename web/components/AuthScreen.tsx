import Link from "next/link";
import { Brand } from "@/components/Brand";
import { CreateOrganizationForm } from "@/components/CreateOrganizationForm";
import { Icon } from "@/components/Icon";
import { LoginForm } from "@/components/LoginForm";

export function AuthScreen({ mode = "sign-in" }: { mode?: "sign-in" | "sign-up" }) {
  const isSignup = mode === "sign-up";

  return (
    <div className="auth-shell">
      <section className="auth-story">
        <div className="auth-story-content">
          <Brand inverse tagline />
          <div className="auth-story-copy">
            <span className="eyebrow">{isSignup ? "Your new people workspace" : "Welcome back"}</span>
            <h1>{isSignup ? "Set the standard for how your team is cared for." : "The clearest view of your people and their work."}</h1>
            <p>
              {isSignup
                ? "Create a secure home for every employee record, approval, milestone, and document—then invite your team when you are ready."
                : "Attendance, leave, onboarding, performance, documents, and pay records stay connected in one calm, secure workspace."}
            </p>
          </div>
          <div className="auth-proof">
            <div><Icon name="shield" size={18} /><strong>Row-secured</strong><span>Database-enforced access</span></div>
            <div><Icon name="grid" size={18} /><strong>All connected</strong><span>One employee lifecycle</span></div>
            <div><Icon name="spark" size={18} /><strong>Configurable</strong><span>Your policies, your flow</span></div>
          </div>
        </div>
      </section>

      <section className="auth-panel">
        <div className="auth-panel-top">
          <Brand />
          <Link href="/">Back to home</Link>
        </div>
        <div className="auth-card">
          <div className="auth-card-header">
            <span className="eyebrow">{isSignup ? "Create an organization" : "Sign in"}</span>
            <h2>{isSignup ? "Build your workspace" : "Welcome back"}</h2>
            <p>
              {isSignup
                ? "For organization owners and HR leaders. You will become the first administrator."
                : "Use the work email connected to your Halomanage account."}
            </p>
          </div>
          {isSignup ? <CreateOrganizationForm /> : <LoginForm />}
          <p className="auth-form-footer">
            {isSignup ? (
              <>Already have an account? <Link href="/login">Sign in</Link><br />Joining an existing organization? Your HR administrator will send your invitation.</>
            ) : (
              <>Setting up Halomanage for your company? <Link href="/signup">Create a workspace</Link></>
            )}
          </p>
        </div>
      </section>
    </div>
  );
}
