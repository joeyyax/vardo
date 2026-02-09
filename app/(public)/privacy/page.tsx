import { Section } from "@/components/marketing/section";

export const metadata = {
  title: "Privacy Policy",
};

export default function PrivacyPage() {
  return (
    <>
      <section className="relative pt-32 pb-12 px-4">
        <div className="max-w-3xl mx-auto">
          <h1 className="text-4xl sm:text-5xl font-bold tracking-tight mb-4">
            Privacy Policy
          </h1>
          <p className="text-muted-foreground">Last updated: February 2026</p>
        </div>
      </section>

      <Section>
        <div className="prose prose-neutral dark:prose-invert max-w-3xl mx-auto">
          <p className="lead">
            Your privacy matters. This document explains what data Scope
            collects, why we collect it, and how it&apos;s handled.
          </p>
          <p>We keep this simple on purpose.</p>

          <h2>What We Collect</h2>
          <p>Scope collects only what&apos;s needed to provide the service.</p>

          <h3>Account Information</h3>
          <ul>
            <li>Name</li>
            <li>Email address</li>
            <li>Organization name</li>
            <li>
              Authentication details (managed securely by our auth provider)
            </li>
          </ul>

          <h3>Work Data</h3>
          <ul>
            <li>Clients, projects, tasks</li>
            <li>Time entries</li>
            <li>Documents (proposals, contracts)</li>
            <li>Expenses and attachments</li>
            <li>Comments and activity history</li>
          </ul>
          <p>This data belongs to you.</p>

          <h2>How We Use Your Data</h2>
          <p>We use your data to:</p>
          <ul>
            <li>Operate the product</li>
            <li>
              Provide core features (time tracking, documents, billing, etc.)
            </li>
            <li>Maintain system integrity and security</li>
            <li>Communicate about your account (transactional emails only)</li>
          </ul>
          <p>
            We do <strong>not</strong>:
          </p>
          <ul>
            <li>Sell your data</li>
            <li>Use your data for advertising</li>
            <li>Train AI models on your private content</li>
          </ul>

          <h2>Client Data Ownership</h2>
          <p>All work data entered into Scope remains yours.</p>
          <p>You may:</p>
          <ul>
            <li>Access your data at any time</li>
            <li>Export your data</li>
            <li>Request a complete copy of your data</li>
          </ul>
          <p>If you stop using Scope, your data is not repurposed.</p>

          <h2>Data Storage &amp; Security</h2>
          <ul>
            <li>Data is stored using reputable infrastructure providers</li>
            <li>Files are stored securely (e.g. object storage)</li>
            <li>Access is restricted by organization and role</li>
            <li>Backups are performed regularly</li>
          </ul>
          <p>
            No system is perfect, but we take reasonable steps to protect your
            data.
          </p>

          <h2>Cookies &amp; Tracking</h2>
          <p>Scope uses minimal cookies required for:</p>
          <ul>
            <li>Authentication</li>
            <li>Session management</li>
            <li>Basic functionality</li>
          </ul>
          <p>We do not use third-party ad trackers.</p>

          <h2>Emails</h2>
          <p>We send emails related to:</p>
          <ul>
            <li>Account access</li>
            <li>Invitations</li>
            <li>Document actions (viewed, accepted, declined)</li>
            <li>Billing and system notifications</li>
          </ul>
          <p>No marketing email lists. No spam.</p>

          <h2>Third-Party Services</h2>
          <p>Scope relies on trusted third-party providers for:</p>
          <ul>
            <li>Authentication</li>
            <li>Email delivery</li>
            <li>File storage</li>
            <li>Infrastructure hosting</li>
          </ul>
          <p>
            These providers only receive the minimum data required to perform
            their function.
          </p>

          <h2>Data Requests &amp; Deletion</h2>
          <p>You may request:</p>
          <ul>
            <li>A copy of your data</li>
            <li>Deletion of your account and associated data</li>
          </ul>
          <p>
            Some data may be retained temporarily for legal or operational
            reasons, then removed.
          </p>

          <h2>Changes</h2>
          <p>
            If this policy changes, we&apos;ll update the date at the top.
            Significant changes will be communicated clearly.
          </p>

          <h2>Contact</h2>
          <p>
            If you have questions about privacy or data handling, reach out at{" "}
            <a href="mailto:hello@usescope.dev">hello@usescope.dev</a>.
          </p>
          <p>We&apos;ll respond like humans.</p>
        </div>
      </Section>
    </>
  );
}
