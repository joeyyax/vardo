import { Section } from "@/components/marketing/section";

export const metadata = {
  title: "Terms of Service",
};

export default function TermsPage() {
  return (
    <>
      <section className="relative pt-32 pb-12 px-4">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            Terms of Service
          </h1>
          <p className="text-muted-foreground">Last updated: February 2026</p>
        </div>
      </section>

      <Section>
        <div className="prose prose-neutral dark:prose-invert max-w-3xl mx-auto">
          <p className="lead">
            These terms govern your use of Scope. By using the service, you
            agree to them.
          </p>
          <p>
            We&apos;ve written these to be clear, not intimidating.
          </p>

          <h2>The Service</h2>
          <p>
            Scope is a software service that helps you manage work: time
            tracking, projects and tasks, proposals and contracts, billing and
            related workflows.
          </p>
          <p>Features may change over time as the product evolves.</p>

          <h2>Your Account</h2>
          <p>You are responsible for:</p>
          <ul>
            <li>Maintaining access to your account</li>
            <li>Keeping your login credentials secure</li>
            <li>Activity performed under your account</li>
          </ul>
          <p>
            You must provide accurate information when creating an account.
          </p>

          <h2>Acceptable Use</h2>
          <p>Please don&apos;t:</p>
          <ul>
            <li>Use Scope for unlawful purposes</li>
            <li>Attempt to access other users&apos; data</li>
            <li>Interfere with or disrupt the service</li>
            <li>Abuse or overload the system</li>
          </ul>
          <p>
            We reserve the right to restrict access if the service is misused.
          </p>

          <h2>Your Data</h2>
          <p>You own your data.</p>
          <p>By using Scope, you grant us permission to:</p>
          <ul>
            <li>Store and process your data</li>
            <li>Display it as needed to provide the service</li>
            <li>Generate exports and reports at your request</li>
          </ul>
          <p>We do not claim ownership of your content.</p>

          <h2>Client-Facing Features</h2>
          <p>If you invite clients or collaborators:</p>
          <ul>
            <li>You are responsible for what they can access</li>
            <li>You control visibility and permissions</li>
            <li>You are responsible for client communications</li>
          </ul>
          <p>Scope provides the tools, not the relationship.</p>

          <h2>Availability</h2>
          <p>We aim for reliable uptime, but:</p>
          <ul>
            <li>Downtime may occur</li>
            <li>Maintenance may be required</li>
            <li>Features may be temporarily unavailable</li>
          </ul>
          <p>
            We do our best, but the service is provided &ldquo;as is.&rdquo;
          </p>

          <h2>Payments &amp; Billing</h2>
          <p>If you subscribe to a paid plan:</p>
          <ul>
            <li>Fees are billed according to the plan selected</li>
            <li>Payments are non-refundable unless stated otherwise</li>
            <li>Pricing may change with notice</li>
          </ul>
          <p>Failure to pay may result in account suspension.</p>

          <h2>Termination</h2>
          <p>You may stop using Scope at any time.</p>
          <p>We may suspend or terminate access if:</p>
          <ul>
            <li>These terms are violated</li>
            <li>The service is abused</li>
            <li>Required payments are not made</li>
          </ul>
          <p>You may request your data before termination.</p>

          <h2>Limitation of Liability</h2>
          <p>To the fullest extent permitted by law:</p>
          <ul>
            <li>
              Scope is not liable for indirect or consequential damages
            </li>
            <li>
              Liability is limited to the amount you paid for the service in
              the last billing period
            </li>
          </ul>
          <p>We&apos;re providing a tool, not a guarantee.</p>

          <h2>Changes to These Terms</h2>
          <p>
            If these terms change, we&apos;ll update the date above. Continued
            use of the service means you accept the updated terms.
          </p>

          <h2>Contact</h2>
          <p>
            Questions about these terms? Reach out at{" "}
            <a href="mailto:hello@usescope.dev">hello@usescope.dev</a>.
          </p>
          <p>We prefer conversation over confrontation.</p>
        </div>
      </Section>
    </>
  );
}
