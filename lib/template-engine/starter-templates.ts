/**
 * System-provided starter templates.
 *
 * These live in code and are always available to every org.
 * Orgs can use them directly (the document snapshots rendered content)
 * or "Save as Template" to customize for future use.
 */

import type { StarterTemplate } from "./types";

// ---------------------------------------------------------------------------
// Common contract terms (shared across contract templates)
// ---------------------------------------------------------------------------

const SIGNATURE_BLOCK_BODY = `By signing below, both parties agree to the terms of this Agreement.

---

**Provider**

Signature: ___________________________

Name: ___________________________

Date: ___________________________

---

**Client**

Signature: ___________________________

Name: ___________________________

Title: ___________________________

Date: ___________________________`;

const COMMON_CONTRACT_TERMS_BODY = `## Client Responsibilities

Client will provide timely access, content, feedback, and decisions necessary to perform the services. Delays do not reduce fees.

## Intellectual Property

Upon full payment, Client owns the final work product created specifically for Client.

Provider retains ownership of pre-existing tools, templates, frameworks, and code. Client receives a perpetual license to use those elements as incorporated.

## Confidentiality

Each party agrees to keep the other party's non-public business information confidential.

## Warranties and Disclaimers

Services are performed in a professional manner. Deliverables are otherwise provided "as is."

## Limitation of Liability

Provider's total liability is limited to the fees paid by Client during the **three (3) months** preceding the event giving rise to the claim.

## Termination

Either party may terminate at any time with written notice. Client is responsible for payment for all work performed.

## Governing Law

This Agreement is governed by Oregon law. Venue is Multnomah County, Oregon.`;

// ---------------------------------------------------------------------------
// Proposal templates
// ---------------------------------------------------------------------------

export const PROPOSAL_TEMPLATES: StarterTemplate[] = [
  {
    id: "hourly-proposal",
    documentType: "proposal",
    name: "Hourly Proposal",
    description: "Bill by the hour with a set rate and billing cadence.",
    category: "hourly",
    sortOrder: 0,
    variableSchema: [
      { key: "ClientName", label: "Client Name", type: "text", required: true, source: "context.clientName" },
      { key: "ProjectName", label: "Project Name", type: "text", required: true, source: "context.projectName" },
      { key: "SystemOfRecord", label: "System of Record", type: "text", defaultValue: "the project workspace" },
      { key: "HourlyRate", label: "Hourly Rate", type: "currency", format: "$%s/hr", required: true, group: "Pricing", section: "pricing" },
      { key: "BillingCadence", label: "Billing Cadence", type: "select", defaultValue: "Monthly", options: [{ label: "Weekly", value: "Weekly" }, { label: "Biweekly", value: "Biweekly" }, { label: "Monthly", value: "Monthly" }], group: "Pricing", section: "pricing" },
      { key: "TimeIncrement", label: "Time Increment", type: "select", defaultValue: "15 minutes", options: [{ label: "6 minutes", value: "6 minutes" }, { label: "15 minutes", value: "15 minutes" }, { label: "30 minutes", value: "30 minutes" }], group: "Pricing", section: "pricing" },
      { key: "ScopeDescription", label: "Scope Description", type: "richtext", section: "scope", defaultValue: "<p>Provider will provide web development and related services as requested.</p><p>Services may include:</p><ul><li>Development and implementation</li><li>Maintenance and updates</li><li>Bug fixes and improvements</li><li>Consulting and guidance</li></ul><p>Requests and priorities will be tracked via the project workspace.</p>" },
    ],
    pricingConfig: { type: "hourly", fieldMap: { rate: "HourlyRate" } },
    sections: [
      { key: "intro", title: "Overview", body: "This proposal outlines hourly web development services for {ClientName}.", mode: "static", order: 0 },
      { key: "scope", title: "Scope of Work", body: "Provider will provide web development and related services as requested.\n\nServices may include development, maintenance, fixes, improvements, and consulting.\n\nRequests and priorities will be tracked via {SystemOfRecord}.", mode: "editable", order: 1 },
      { key: "pricing", title: "Pricing", body: "- Hourly rate: **{HourlyRate}**\n- Billing cadence: **{BillingCadence}**\n- Minimum time increment: **{TimeIncrement}**\n\nInvoices are due within thirty (30) days.", mode: "form-driven", order: 2 },
      { key: "timeline", title: "Timeline", body: "Work begins upon agreement execution. Hours are tracked and billed per the cadence above.", mode: "static", order: 3 },
      { key: "assumptions", title: "Assumptions", body: "- Estimates are good-faith projections, not guarantees\n- Provider may pause work if an invoice remains unpaid", mode: "static", order: 4 },
      { key: "next_steps", title: "Next Steps", body: "If approved, a service agreement will be issued before work begins.", mode: "static", order: 5 },
    ],
  },
  {
    id: "retainer-proposal",
    documentType: "proposal",
    name: "Retainer Proposal",
    description: "Monthly retainer with included hours. Unused hours roll over one month.",
    category: "retainer",
    sortOrder: 1,
    variableSchema: [
      { key: "ClientName", label: "Client Name", type: "text", required: true, source: "context.clientName" },
      { key: "SystemOfRecord", label: "System of Record", type: "text", defaultValue: "the project workspace" },
      { key: "IncludedHours", label: "Included Hours/Month", type: "number", required: true, group: "Pricing", section: "capacity" },
      { key: "RetainerAmount", label: "Monthly Retainer", type: "currency", format: "$%s/mo", required: true, group: "Pricing", section: "pricing" },
      { key: "StartDate", label: "Start Date", type: "date", required: true, group: "Timeline", section: "timeline" },
      { key: "ScopeDescription", label: "Scope Description", type: "richtext", section: "scope", defaultValue: "<p>Typical services may include:</p><ul><li>Maintenance and updates</li><li>Bug fixes and small improvements</li><li>Consulting and guidance</li><li>Ongoing support as needs arise</li></ul><p>Work is prioritized collaboratively.</p>" },
    ],
    pricingConfig: { type: "retainer", fieldMap: { amount: "RetainerAmount", estimatedHours: "IncludedHours" } },
    sections: [
      { key: "intro", title: "Overview", body: "This proposal outlines an ongoing retainer arrangement to support, maintain, and improve {ClientName}'s website or web systems.", mode: "static", order: 0 },
      { key: "scope", title: "Scope of Work", body: "Typical services may include:\n- Maintenance and updates\n- Bug fixes and small improvements\n- Consulting and guidance\n- Ongoing support as needs arise\n\nWork is prioritized collaboratively.", mode: "editable", order: 1 },
      { key: "capacity", title: "Included Capacity", body: "- Up to **{IncludedHours} hours per month**\n- Unused hours may roll over one month", mode: "form-driven", order: 2 },
      { key: "pricing", title: "Pricing", body: "- Monthly retainer: **{RetainerAmount}**\n- Billed monthly", mode: "form-driven", order: 3 },
      { key: "timeline", title: "Timeline", body: "- Start date: {StartDate}\n- Initial commitment: 3 months", mode: "form-driven", order: 4 },
      { key: "assumptions", title: "Assumptions", body: "- Requests are submitted via {SystemOfRecord}\n- Availability is scheduled, not guaranteed\n- Larger initiatives may require a separate agreement", mode: "static", order: 5 },
      { key: "next_steps", title: "Next Steps", body: "If approved, a service agreement will be generated reflecting these terms.", mode: "static", order: 6 },
    ],
  },
  {
    id: "retainer-hybrid-proposal",
    documentType: "proposal",
    name: "Retainer + Additional Hours Proposal",
    description: "Monthly retainer with included hours, plus overage billing for additional work.",
    category: "retainer",
    sortOrder: 2,
    variableSchema: [
      { key: "ClientName", label: "Client Name", type: "text", required: true, source: "context.clientName" },
      { key: "IncludedHours", label: "Included Hours/Month", type: "number", required: true, group: "Pricing", section: "capacity" },
      { key: "RetainerAmount", label: "Monthly Retainer", type: "currency", format: "$%s/mo", required: true, group: "Pricing", section: "pricing" },
      { key: "OverageRate", label: "Overage Rate", type: "currency", format: "$%s/hr", required: true, group: "Pricing", section: "additional" },
      { key: "StartDate", label: "Start Date", type: "date", required: true, group: "Timeline", section: "timeline" },
      { key: "ScopeDescription", label: "Scope Description", type: "richtext", section: "scope", defaultValue: "<p>Ongoing web development, maintenance, improvements, and consulting as requested.</p><ul><li>Development and implementation</li><li>Maintenance and updates</li><li>Bug fixes and improvements</li><li>Consulting and guidance</li></ul>" },
    ],
    pricingConfig: { type: "retainer", fieldMap: { amount: "RetainerAmount", rate: "OverageRate", estimatedHours: "IncludedHours" } },
    sections: [
      { key: "intro", title: "Overview", body: "This proposal combines a monthly retainer with the flexibility to add additional hours as needed.", mode: "static", order: 0 },
      { key: "scope", title: "Scope of Work", body: "Ongoing web development, maintenance, improvements, and consulting as requested by {ClientName}.", mode: "editable", order: 1 },
      { key: "capacity", title: "Included Capacity", body: "- Up to **{IncludedHours} hours per month**\n- One-month rollover on unused hours", mode: "form-driven", order: 2 },
      { key: "additional", title: "Additional Work", body: "Work beyond included hours may be approved and billed at:\n- **{OverageRate} per hour**", mode: "form-driven", order: 3 },
      { key: "pricing", title: "Pricing", body: "- Monthly retainer: **{RetainerAmount}**\n- Additional hours billed monthly as needed", mode: "form-driven", order: 4 },
      { key: "timeline", title: "Timeline", body: "- Start date: {StartDate}\n- Initial commitment: 3 months", mode: "form-driven", order: 5 },
      { key: "assumptions", title: "Assumptions", body: "- Approval is required before overage work\n- Larger efforts may be scoped separately", mode: "static", order: 6 },
      { key: "next_steps", title: "Next Steps", body: "Upon approval, a service agreement will be prepared.", mode: "static", order: 7 },
    ],
  },
  {
    id: "fixed-scope-proposal",
    documentType: "proposal",
    name: "Fixed Scope Proposal",
    description: "Defined deliverables with a fixed fee and payment schedule.",
    category: "fixed",
    sortOrder: 3,
    variableSchema: [
      { key: "ClientName", label: "Client Name", type: "text", required: true, source: "context.clientName" },
      { key: "DeliverablesList", label: "Deliverables", type: "richtext", required: true, section: "scope", defaultValue: "<ul><li>Design mockups and revisions</li><li>Front-end development</li><li>CMS integration and content setup</li><li>Launch and post-launch support</li></ul>" },
      { key: "OutOfScopeList", label: "Out of Scope", type: "richtext", section: "out_of_scope", defaultValue: "<ul><li>Content writing or copywriting</li><li>Photography or video production</li><li>Ongoing maintenance (available separately)</li></ul>" },
      { key: "StartDate", label: "Start Date", type: "date", required: true, group: "Timeline", section: "timeline" },
      { key: "TargetCompletionDate", label: "Target Completion", type: "date", group: "Timeline", section: "timeline" },
      { key: "FixedFeeAmount", label: "Project Fee", type: "currency", format: "$%s", required: true, group: "Pricing", section: "pricing" },
      { key: "DepositAmount", label: "Deposit", type: "currency", format: "$%s", group: "Pricing", section: "pricing" },
    ],
    pricingConfig: { type: "fixed", fieldMap: { amount: "FixedFeeAmount" } },
    sections: [
      { key: "intro", title: "Overview", body: "This proposal covers a fixed-scope project with clearly defined deliverables and pricing.", mode: "static", order: 0 },
      { key: "scope", title: "Scope of Work", body: "The project includes:\n{DeliverablesList}", mode: "editable", order: 1 },
      { key: "out_of_scope", title: "Out of Scope", body: "The following are not included:\n{OutOfScopeList}", mode: "editable", order: 2 },
      { key: "timeline", title: "Timeline", body: "- Estimated start: {StartDate}\n- Estimated completion: {TargetCompletionDate}\n\nTimelines depend on timely feedback and access.", mode: "form-driven", order: 3 },
      { key: "pricing", title: "Pricing", body: "- Fixed project fee: **{FixedFeeAmount}**\n\nPayment schedule:\n- {DepositAmount} deposit upon agreement\n- Balance due upon completion", mode: "form-driven", order: 4 },
      { key: "assumptions", title: "Assumptions", body: "- Scope changes may affect pricing and timeline\n- Client feedback is required at review stages", mode: "static", order: 5 },
      { key: "next_steps", title: "Next Steps", body: "If approved, a service agreement will be issued before work begins.", mode: "static", order: 6 },
    ],
  },
  {
    id: "maintenance-proposal",
    documentType: "proposal",
    name: "Maintenance Only Proposal",
    description: "Ongoing maintenance — updates, monitoring, minor fixes. No feature development.",
    category: "maintenance",
    sortOrder: 4,
    variableSchema: [
      { key: "IncludedHours", label: "Included Hours/Month", type: "number", required: true, group: "Pricing", section: "capacity" },
      { key: "MaintenanceFee", label: "Monthly Fee", type: "currency", format: "$%s/mo", required: true, group: "Pricing", section: "pricing" },
      { key: "StartDate", label: "Start Date", type: "date", required: true, group: "Timeline", section: "timeline" },
    ],
    pricingConfig: { type: "retainer", fieldMap: { amount: "MaintenanceFee", estimatedHours: "IncludedHours" } },
    sections: [
      { key: "intro", title: "Overview", body: "This proposal covers ongoing website maintenance to keep systems stable, secure, and up to date.", mode: "static", order: 0 },
      { key: "scope", title: "Included Services", body: "- Software updates\n- Monitoring and basic upkeep\n- Minor fixes and adjustments", mode: "editable", order: 1 },
      { key: "exclusions", title: "Exclusions", body: "- Feature development\n- Redesigns\n- Emergency or after-hours work\n- Third-party failures", mode: "static", order: 2 },
      { key: "capacity", title: "Included Capacity", body: "- Up to **{IncludedHours} hours per month**\n- One-month rollover", mode: "form-driven", order: 3 },
      { key: "pricing", title: "Pricing", body: "- Monthly maintenance fee: **{MaintenanceFee}**", mode: "form-driven", order: 4 },
      { key: "timeline", title: "Timeline", body: "- Start date: {StartDate}\n- Initial commitment: 3 months", mode: "form-driven", order: 5 },
      { key: "next_steps", title: "Next Steps", body: "Approval will trigger a maintenance service agreement.", mode: "static", order: 6 },
    ],
  },
  {
    id: "task-proposal",
    documentType: "proposal",
    name: "One-Off Task Proposal",
    description: "A single, well-defined task with a fixed or hourly price.",
    category: "task",
    sortOrder: 5,
    variableSchema: [
      { key: "TaskDescription", label: "Task Description", type: "richtext", required: true, section: "scope", defaultValue: "<p>Describe the specific task or deliverable here, including:</p><ul><li>What needs to be done</li><li>Any technical requirements or constraints</li><li>Expected outcome or deliverable</li></ul>" },
      { key: "PricingType", label: "Pricing Type", type: "select", required: true, options: [{ label: "Fixed", value: "Fixed" }, { label: "Hourly", value: "Hourly" }], group: "Pricing", section: "pricing" },
      { key: "Price", label: "Price", type: "currency", format: "$%s", required: true, group: "Pricing", section: "pricing" },
      { key: "EstimatedCompletion", label: "Estimated Completion", type: "text", defaultValue: "TBD", group: "Timeline", section: "timeline" },
    ],
    pricingConfig: { type: "fixed", fieldMap: { amount: "Price" } },
    sections: [
      { key: "intro", title: "Overview", body: "This proposal covers a specific, one-time task.", mode: "static", order: 0 },
      { key: "scope", title: "Task Description", body: "{TaskDescription}", mode: "editable", order: 1 },
      { key: "pricing", title: "Pricing", body: "- {PricingType}: **{Price}**", mode: "form-driven", order: 2 },
      { key: "timeline", title: "Timeline", body: "Estimated completion: {EstimatedCompletion}", mode: "form-driven", order: 3 },
      { key: "assumptions", title: "Assumptions", body: "- Scope is limited to the task described\n- Additional requests require a new proposal", mode: "static", order: 4 },
      { key: "next_steps", title: "Next Steps", body: "If approved, a short service agreement will be provided.", mode: "static", order: 5 },
    ],
  },
  {
    id: "consulting-proposal",
    documentType: "proposal",
    name: "Consulting Proposal",
    description: "Advisory and strategy services. No implementation unless separately agreed.",
    category: "consulting",
    sortOrder: 6,
    variableSchema: [
      { key: "ConsultingRate", label: "Consulting Rate", type: "currency", format: "$%s/hr", required: true, group: "Pricing", section: "pricing" },
      { key: "BillingCadence", label: "Billing Cadence", type: "select", defaultValue: "Monthly", options: [{ label: "Weekly", value: "Weekly" }, { label: "Biweekly", value: "Biweekly" }, { label: "Monthly", value: "Monthly" }], group: "Pricing", section: "pricing" },
      { key: "ScopeDescription", label: "Scope Description", type: "richtext", section: "scope", defaultValue: "<p>Services may include:</p><ul><li>Technical review and recommendations</li><li>Architecture and planning guidance</li><li>Strategy discussions and feedback</li></ul><p>Provider does not implement changes unless separately agreed.</p>" },
    ],
    pricingConfig: { type: "hourly", fieldMap: { rate: "ConsultingRate" } },
    sections: [
      { key: "intro", title: "Overview", body: "This proposal covers advisory and consulting services related to web architecture, systems, or strategy.", mode: "static", order: 0 },
      { key: "scope", title: "Consulting Services", body: "Services may include:\n- Technical review and recommendations\n- Architecture and planning guidance\n- Strategy discussions and feedback\n\nProvider does not implement changes unless separately agreed.", mode: "editable", order: 1 },
      { key: "pricing", title: "Pricing", body: "- Rate: **{ConsultingRate}**\n- Billing cadence: **{BillingCadence}**", mode: "form-driven", order: 2 },
      { key: "timeline", title: "Timeline", body: "Consulting sessions scheduled as agreed.", mode: "static", order: 3 },
      { key: "assumptions", title: "Assumptions", body: "- Client is responsible for implementation decisions\n- Advice is based on available information", mode: "static", order: 4 },
      { key: "next_steps", title: "Next Steps", body: "If approved, a consulting agreement will be issued.", mode: "static", order: 5 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Contract templates
// ---------------------------------------------------------------------------

export const CONTRACT_TEMPLATES: StarterTemplate[] = [
  {
    id: "hourly-contract",
    documentType: "contract",
    name: "Service Agreement (Hourly)",
    description: "Hourly rate agreement with billing cadence and time tracking.",
    category: "hourly",
    sortOrder: 0,
    variableSchema: [
      { key: "EffectiveDate", label: "Effective Date", type: "date", required: true, source: "context.date", group: "Dates" },
      { key: "SystemOfRecord", label: "System of Record", type: "text", defaultValue: "the project workspace" },
      { key: "HourlyRate", label: "Hourly Rate", type: "currency", format: "$%s/hr", required: true, group: "Pricing", section: "pricing" },
      { key: "BillingCadence", label: "Billing Cadence", type: "select", defaultValue: "Monthly", options: [{ label: "Weekly", value: "Weekly" }, { label: "Biweekly", value: "Biweekly" }, { label: "Monthly", value: "Monthly" }], group: "Pricing", section: "pricing" },
      { key: "TimeIncrement", label: "Time Increment", type: "select", defaultValue: "15 minutes", options: [{ label: "6 minutes", value: "6 minutes" }, { label: "15 minutes", value: "15 minutes" }, { label: "30 minutes", value: "30 minutes" }], group: "Pricing", section: "pricing" },
    ],
    pricingConfig: { type: "hourly", fieldMap: { rate: "HourlyRate" } },
    sections: [
      { key: "intro", title: "Introduction", body: "This Service Agreement is entered into as of **{EffectiveDate}** between Provider and Client.\n\nIf a proposal is referenced, it is included for scope and pricing only. If there is a conflict, this Agreement controls.", mode: "static", order: 0 },
      { key: "scope", title: "Services", body: "Provider will provide web development and related services as requested by Client. Services may include development, maintenance, fixes, improvements, and consulting.\n\nRequests and priorities may be tracked through **{SystemOfRecord}**.", mode: "editable", order: 1 },
      { key: "pricing", title: "Hourly Rate and Billing", body: "- Hourly rate: **{HourlyRate}**\n- Billing cadence: **{BillingCadence}**\n- Minimum time increment: **{TimeIncrement}**\n\nInvoices are due within **thirty (30) days** of the invoice date.", mode: "form-driven", order: 2 },
      { key: "estimates", title: "Estimates", body: "Any estimates are good-faith projections only and are not guarantees.", mode: "static", order: 3 },
      { key: "payment", title: "Payment", body: "No late fees are charged. Provider may pause work if an invoice remains unpaid after the due date.", mode: "static", order: 4 },
      { key: "terms", title: "Terms & Conditions", body: COMMON_CONTRACT_TERMS_BODY, mode: "static", order: 5 },
      { key: "signatures", title: "Signatures", body: SIGNATURE_BLOCK_BODY, mode: "static", order: 6 },
    ],
  },
  {
    id: "retainer-contract",
    documentType: "contract",
    name: "Service Agreement (Retainer)",
    description: "Monthly retainer with included hours and rollover.",
    category: "retainer",
    sortOrder: 1,
    variableSchema: [
      { key: "EffectiveDate", label: "Effective Date", type: "date", required: true, source: "context.date", group: "Dates" },
      { key: "StartDate", label: "Start Date", type: "date", required: true, group: "Dates", section: "term" },
      { key: "SystemOfRecord", label: "System of Record", type: "text", defaultValue: "the project workspace" },
      { key: "RetainerAmount", label: "Monthly Retainer", type: "currency", format: "$%s/mo", required: true, group: "Pricing", section: "pricing" },
      { key: "IncludedHours", label: "Included Hours/Month", type: "number", required: true, group: "Pricing", section: "pricing" },
    ],
    pricingConfig: { type: "retainer", fieldMap: { amount: "RetainerAmount", estimatedHours: "IncludedHours" } },
    sections: [
      { key: "intro", title: "Introduction", body: "This Agreement is entered into as of **{EffectiveDate}** between Provider and Client.", mode: "static", order: 0 },
      { key: "term", title: "Term", body: "The Agreement begins on **{StartDate}** and continues for an initial term of **three (3) months**.\n\nIt automatically renews for additional three-month terms unless either party gives written notice at least **one full term** before renewal.", mode: "form-driven", order: 1 },
      { key: "scope", title: "Services", body: "Provider will provide ongoing web development and related services as requested by Client.\n\nRequests may be tracked via **{SystemOfRecord}**.\n\nProvider does not guarantee availability at specific times or completion of a fixed number of hours in any given month.", mode: "editable", order: 2 },
      { key: "pricing", title: "Retainer and Included Hours", body: "- Monthly retainer: **{RetainerAmount}**\n- Included work: **Up to {IncludedHours} hours per month**\n\n### Rollover\nUnused hours may roll over to the immediately following month only and then expire.", mode: "form-driven", order: 3 },
      { key: "overage", title: "Work Beyond Included Hours", body: "Work beyond included and rolled-over hours will not be performed without Client approval and may require a separate agreement.", mode: "static", order: 4 },
      { key: "billing", title: "Billing", body: "Invoices are issued monthly and due Net 30. Provider may pause work if unpaid.", mode: "static", order: 5 },
      { key: "terms", title: "Terms & Conditions", body: COMMON_CONTRACT_TERMS_BODY, mode: "static", order: 6 },
      { key: "signatures", title: "Signatures", body: SIGNATURE_BLOCK_BODY, mode: "static", order: 7 },
    ],
  },
  {
    id: "retainer-hybrid-contract",
    documentType: "contract",
    name: "Service Agreement (Retainer + Additional Hours)",
    description: "Retainer with included hours plus overage billing.",
    category: "retainer",
    sortOrder: 2,
    variableSchema: [
      { key: "EffectiveDate", label: "Effective Date", type: "date", required: true, source: "context.date", group: "Dates" },
      { key: "RetainerAmount", label: "Monthly Retainer", type: "currency", format: "$%s/mo", required: true, group: "Pricing", section: "pricing" },
      { key: "IncludedHours", label: "Included Hours/Month", type: "number", required: true, group: "Pricing", section: "pricing" },
      { key: "OverageRate", label: "Overage Rate", type: "currency", format: "$%s/hr", required: true, group: "Pricing", section: "additional" },
    ],
    pricingConfig: { type: "retainer", fieldMap: { amount: "RetainerAmount", rate: "OverageRate", estimatedHours: "IncludedHours" } },
    sections: [
      { key: "intro", title: "Introduction", body: "This Agreement is entered into as of **{EffectiveDate}** between Provider and Client.", mode: "static", order: 0 },
      { key: "term", title: "Term", body: "Three-month term, renewing every three months unless canceled with one full term notice.", mode: "static", order: 1 },
      { key: "scope", title: "Services", body: "Ongoing web development and related services as requested by Client.", mode: "editable", order: 2 },
      { key: "pricing", title: "Retainer and Included Hours", body: "- Monthly retainer: **{RetainerAmount}**\n- Included work: **Up to {IncludedHours} hours per month**\n\nUnused hours roll over one month only.", mode: "form-driven", order: 3 },
      { key: "additional", title: "Additional Hours", body: "Work beyond included hours:\n- Billed at **{OverageRate}**\n- Requires Client approval", mode: "form-driven", order: 4 },
      { key: "billing", title: "Billing", body: "Retainer and overages are billed monthly. Net 30.", mode: "static", order: 5 },
      { key: "terms", title: "Terms & Conditions", body: COMMON_CONTRACT_TERMS_BODY, mode: "static", order: 6 },
      { key: "signatures", title: "Signatures", body: SIGNATURE_BLOCK_BODY, mode: "static", order: 7 },
    ],
  },
  {
    id: "fixed-scope-contract",
    documentType: "contract",
    name: "Service Agreement (Fixed Scope)",
    description: "Fixed fee for defined deliverables with payment schedule.",
    category: "fixed",
    sortOrder: 3,
    variableSchema: [
      { key: "EffectiveDate", label: "Effective Date", type: "date", required: true, source: "context.date", group: "Dates" },
      { key: "StartDate", label: "Start Date", type: "date", required: true, group: "Dates", section: "timeline" },
      { key: "DeliverablesList", label: "Deliverables", type: "richtext", required: true, section: "scope", defaultValue: "<ul><li>Design mockups and revisions</li><li>Front-end development</li><li>CMS integration and content setup</li><li>Launch and post-launch support</li></ul>" },
      { key: "OutOfScopeList", label: "Out of Scope", type: "richtext", section: "scope", defaultValue: "<ul><li>Content writing or copywriting</li><li>Photography or video production</li><li>Ongoing maintenance (available separately)</li></ul>" },
      { key: "FixedFeeAmount", label: "Total Fee", type: "currency", format: "$%s", required: true, group: "Pricing", section: "pricing" },
      { key: "DepositAmount", label: "Deposit", type: "currency", format: "$%s", group: "Pricing", section: "pricing" },
      { key: "IncludedRevisions", label: "Included Revisions", type: "number", defaultValue: "2", group: "Pricing", section: "revisions" },
      { key: "HourlyRateForRevisions", label: "Additional Revision Rate", type: "currency", format: "$%s/hr", group: "Pricing", section: "revisions" },
    ],
    pricingConfig: { type: "fixed", fieldMap: { amount: "FixedFeeAmount" } },
    sections: [
      { key: "intro", title: "Introduction", body: "This Agreement is entered into as of **{EffectiveDate}** between Provider and Client.", mode: "static", order: 0 },
      { key: "scope", title: "Scope of Work", body: "Provider will deliver the following:\n\n**Deliverables**\n{DeliverablesList}\n\n**Out of Scope**\n{OutOfScopeList}", mode: "editable", order: 1 },
      { key: "timeline", title: "Timeline", body: "Work begins on or after **{StartDate}**. Timelines depend on timely Client feedback.", mode: "form-driven", order: 2 },
      { key: "pricing", title: "Fees and Payment", body: "- Total fee: **{FixedFeeAmount}**\n\nPayment schedule:\n- Deposit: **{DepositAmount}**\n- Balance due upon completion\n\nNet 30.", mode: "form-driven", order: 3 },
      { key: "revisions", title: "Revisions", body: "Includes **{IncludedRevisions}** revision rounds. Additional revisions billed at **{HourlyRateForRevisions}**.", mode: "form-driven", order: 4 },
      { key: "terms", title: "Terms & Conditions", body: COMMON_CONTRACT_TERMS_BODY, mode: "static", order: 5 },
      { key: "signatures", title: "Signatures", body: SIGNATURE_BLOCK_BODY, mode: "static", order: 6 },
    ],
  },
  {
    id: "maintenance-contract",
    documentType: "contract",
    name: "Service Agreement (Maintenance Only)",
    description: "Ongoing maintenance agreement for updates, monitoring, and fixes.",
    category: "maintenance",
    sortOrder: 4,
    variableSchema: [
      { key: "EffectiveDate", label: "Effective Date", type: "date", required: true, source: "context.date", group: "Dates" },
      { key: "MaintenanceFee", label: "Monthly Fee", type: "currency", format: "$%s/mo", required: true, group: "Pricing", section: "pricing" },
      { key: "IncludedHours", label: "Included Hours/Month", type: "number", required: true, group: "Pricing", section: "pricing" },
    ],
    pricingConfig: { type: "retainer", fieldMap: { amount: "MaintenanceFee", estimatedHours: "IncludedHours" } },
    sections: [
      { key: "intro", title: "Introduction", body: "This Agreement is entered into as of **{EffectiveDate}** between Provider and Client.", mode: "static", order: 0 },
      { key: "scope", title: "Services", body: "Maintenance services may include updates, monitoring, security patching, and minor fixes.\n\nThis Agreement does not include feature development, redesigns, or new functionality.", mode: "editable", order: 1 },
      { key: "term", title: "Term", body: "Three-month term, renewing every three months with one term notice required to cancel.", mode: "static", order: 2 },
      { key: "pricing", title: "Fees", body: "- Monthly maintenance fee: **{MaintenanceFee}**\n\nIncludes up to **{IncludedHours} hours** of maintenance work per month.\n\nUnused hours roll over one month only.", mode: "form-driven", order: 3 },
      { key: "exclusions", title: "Exclusions", body: "Maintenance does not include emergencies, third-party failures, or major changes unless separately agreed.", mode: "static", order: 4 },
      { key: "terms", title: "Terms & Conditions", body: COMMON_CONTRACT_TERMS_BODY, mode: "static", order: 5 },
      { key: "signatures", title: "Signatures", body: SIGNATURE_BLOCK_BODY, mode: "static", order: 6 },
    ],
  },
  {
    id: "task-contract",
    documentType: "contract",
    name: "Service Agreement (One-Off Task)",
    description: "Simple agreement for a single defined task.",
    category: "task",
    sortOrder: 5,
    variableSchema: [
      { key: "EffectiveDate", label: "Effective Date", type: "date", required: true, source: "context.date", group: "Dates" },
      { key: "TaskDescription", label: "Task Description", type: "richtext", required: true, section: "scope", defaultValue: "<p>Describe the specific task or deliverable here, including:</p><ul><li>What needs to be done</li><li>Any technical requirements or constraints</li><li>Expected outcome or deliverable</li></ul>" },
      { key: "Price", label: "Price", type: "currency", format: "$%s", required: true, group: "Pricing", section: "pricing" },
      { key: "PricingType", label: "Pricing Type", type: "select", required: true, options: [{ label: "Fixed", value: "Fixed" }, { label: "Hourly", value: "Hourly" }], group: "Pricing", section: "pricing" },
    ],
    pricingConfig: { type: "fixed", fieldMap: { amount: "Price" } },
    sections: [
      { key: "intro", title: "Introduction", body: "This Agreement is entered into as of **{EffectiveDate}** between Provider and Client.", mode: "static", order: 0 },
      { key: "scope", title: "Task", body: "Provider will perform the following task(s):\n\n{TaskDescription}", mode: "editable", order: 1 },
      { key: "pricing", title: "Fees", body: "- Pricing: **{Price}** ({PricingType})\n\nNet 30.", mode: "form-driven", order: 2 },
      { key: "completion", title: "Completion", body: "This Agreement ends once the task is completed and paid.", mode: "static", order: 3 },
      { key: "terms", title: "Terms & Conditions", body: COMMON_CONTRACT_TERMS_BODY, mode: "static", order: 4 },
      { key: "signatures", title: "Signatures", body: SIGNATURE_BLOCK_BODY, mode: "static", order: 5 },
    ],
  },
  {
    id: "consulting-contract",
    documentType: "contract",
    name: "Consulting Services Agreement",
    description: "Advisory, architectural, or strategic consulting agreement.",
    category: "consulting",
    sortOrder: 6,
    variableSchema: [
      { key: "EffectiveDate", label: "Effective Date", type: "date", required: true, source: "context.date", group: "Dates" },
      { key: "ConsultingRate", label: "Consulting Rate", type: "currency", format: "$%s/hr", required: true, group: "Pricing", section: "pricing" },
      { key: "BillingCadence", label: "Billing Cadence", type: "select", defaultValue: "Monthly", options: [{ label: "Weekly", value: "Weekly" }, { label: "Biweekly", value: "Biweekly" }, { label: "Monthly", value: "Monthly" }], group: "Pricing", section: "pricing" },
    ],
    pricingConfig: { type: "hourly", fieldMap: { rate: "ConsultingRate" } },
    sections: [
      { key: "intro", title: "Introduction", body: "This Agreement is entered into as of **{EffectiveDate}** between Provider and Client.", mode: "static", order: 0 },
      { key: "scope", title: "Consulting Services", body: "Provider will provide advisory, architectural, or strategic consulting services.\n\nProvider does not implement changes unless separately agreed.", mode: "editable", order: 1 },
      { key: "pricing", title: "Fees", body: "- Rate: **{ConsultingRate}**\n- Billing cadence: **{BillingCadence}**\n\nNet 30.", mode: "form-driven", order: 2 },
      { key: "no_guarantee", title: "No Guarantee", body: "Client acknowledges that consulting involves judgment and tradeoffs. Provider does not guarantee outcomes.", mode: "static", order: 3 },
      { key: "client_responsibility", title: "Client Responsibility", body: "Client is responsible for decisions and implementation based on consulting advice.", mode: "static", order: 4 },
      { key: "terms", title: "Terms & Conditions", body: COMMON_CONTRACT_TERMS_BODY, mode: "static", order: 5 },
      { key: "signatures", title: "Signatures", body: SIGNATURE_BLOCK_BODY, mode: "static", order: 6 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Change order template
// ---------------------------------------------------------------------------

export const CHANGE_ORDER_TEMPLATES: StarterTemplate[] = [
  {
    id: "change-order",
    documentType: "change_order",
    name: "Change Order",
    description: "Document a scope change with impact on timeline and budget.",
    category: "change_order",
    sortOrder: 0,
    variableSchema: [
      { key: "ProjectName", label: "Project Name", type: "text", required: true, source: "context.projectName" },
      { key: "ClientName", label: "Client Name", type: "text", required: true, source: "context.clientName" },
      { key: "ChangeDescription", label: "Summary of Changes", type: "richtext", required: true, section: "summary", defaultValue: "<p>Describe the requested changes:</p><ul><li>What is being added, removed, or modified</li><li>Why the change is needed</li></ul>" },
      { key: "ScopeImpact", label: "Scope Impact", type: "richtext", section: "scope_impact", defaultValue: "<p>Describe how this change affects the original scope:</p><ul><li>New deliverables or requirements</li><li>Removed or deferred items</li></ul>" },
      { key: "TimelineImpact", label: "Timeline Impact", type: "text", section: "timeline_impact" },
      { key: "BudgetImpact", label: "Budget Impact", type: "currency", format: "$%s", section: "budget_impact" },
      { key: "BudgetImpactNote", label: "Budget Notes", type: "textarea", section: "budget_impact" },
    ],
    sections: [
      { key: "summary", title: "Summary of Changes", body: "The following changes are requested for {ProjectName}:\n\n{ChangeDescription}", mode: "editable", order: 0 },
      { key: "scope_impact", title: "Scope Impact", body: "{ScopeImpact}", mode: "editable", order: 1 },
      { key: "timeline_impact", title: "Timeline Impact", body: "Impact on project timeline: {TimelineImpact}", mode: "form-driven", order: 2 },
      { key: "budget_impact", title: "Budget Impact", body: "Additional cost: **{BudgetImpact}**\n\n{BudgetImpactNote}", mode: "form-driven", order: 3 },
      { key: "approval", title: "Approval", body: "By accepting this change order, both parties agree to the modifications described above. The original agreement remains in effect for all other terms.", mode: "static", order: 4 },
    ],
  },
];

// ---------------------------------------------------------------------------
// Addendum templates
// ---------------------------------------------------------------------------

export const ADDENDUM_TEMPLATES: StarterTemplate[] = [
  {
    id: "hosting-addendum",
    documentType: "addendum",
    name: "Hosting Addendum",
    description: "Terms for managed application hosting.",
    category: "hosting",
    sortOrder: 0,
    variableSchema: [],
    sections: [
      { key: "model", title: "Hosting Model", body: "Provider offers managed application hosting. Client does not receive direct server access (SSH, FTP, or similar).\n\nHosting includes application deployment, runtime management, and database hosting.", mode: "static", order: 0 },
      { key: "what_hosted", title: "What Is Hosted", body: "- Application source code\n- Runtime environment and dependencies\n- Database\n- Media files (via client-owned object storage)", mode: "static", order: 1 },
      { key: "access", title: "Access and Control", body: "Provider maintains full control over the hosting environment. Client accesses the application through admin interfaces and the project workspace.", mode: "static", order: 2 },
      { key: "backups", title: "Backups", body: "Provider maintains backups for recovery purposes. Backups are not guaranteed protection against all data loss scenarios.", mode: "static", order: 3 },
      { key: "data_ownership", title: "Data Ownership", body: "Client owns all data, content, and application code created for the project.\n\nClient may request a full data export at any time. Exports include application source code, a database backup, and uploaded media/assets.", mode: "static", order: 4 },
      { key: "fees", title: "Hosting Fees", body: "Hosting is billed separately from development services.\n\nFees and billing cadence are as specified in the service agreement.", mode: "static", order: 5 },
      { key: "termination", title: "Termination and Transition", body: "If hosting ends, Provider will:\n- Provide complete data exports\n- Allow reasonable time for transition\n- Offer optional migration assistance (may be billed separately)", mode: "static", order: 6 },
    ],
  },
  {
    id: "support-expectations-addendum",
    documentType: "addendum",
    name: "Support Expectations",
    description: "Response times and communication norms.",
    category: "support",
    sortOrder: 1,
    variableSchema: [],
    sections: [
      { key: "normal", title: "Normal Requests", body: "- Submitted via the project workspace\n- Typical response time: within one business day\n- Scheduled based on priority and availability", mode: "static", order: 0 },
      { key: "urgent", title: "Urgent Requests", body: "Urgent issues may include:\n- Site outages\n- Critical errors blocking normal use\n\nUrgent requests should be clearly labeled.", mode: "static", order: 1 },
      { key: "not_emergency", title: "What Is Not Emergency Support", body: "- Feature requests\n- Design changes\n- Content edits\n- Third-party outages", mode: "static", order: 2 },
      { key: "hours", title: "Business Hours", body: "Support is provided during regular business hours.\n\nThis document does not create a guaranteed SLA unless explicitly stated in writing.", mode: "static", order: 3 },
    ],
  },
  {
    id: "responsibility-matrix-addendum",
    documentType: "addendum",
    name: "Responsibility Matrix",
    description: "Who handles what — provider, client, third party.",
    category: "responsibility",
    sortOrder: 2,
    variableSchema: [],
    sections: [
      { key: "overview", title: "Responsibility Overview", body: "This document outlines responsibility boundaries to avoid confusion.\n\nResponsibilities should be discussed and confirmed together.", mode: "static", order: 0 },
      { key: "matrix", title: "Responsibility Areas", body: "| Area | Provider | Client | Third Party |\n|------|----------|--------|-------------|\n| Hosting uptime | ☐ | ☐ | ☐ |\n| Backups | ☐ | ☐ | ☐ |\n| CMS updates | ☐ | ☐ | ☐ |\n| Plugin / dependency updates | ☐ | ☐ | ☐ |\n| Security monitoring | ☐ | ☐ | ☐ |\n| Content updates | ☐ | ☐ | ☐ |\n| DNS / domain management | ☐ | ☐ | ☐ |", mode: "editable", order: 1 },
    ],
  },
];

// ---------------------------------------------------------------------------
// All starter templates (combined)
// ---------------------------------------------------------------------------

export const ALL_STARTER_TEMPLATES: StarterTemplate[] = [
  ...PROPOSAL_TEMPLATES,
  ...CONTRACT_TEMPLATES,
  ...CHANGE_ORDER_TEMPLATES,
  ...ADDENDUM_TEMPLATES,
];

/**
 * Find a starter template by ID.
 */
export function getStarterTemplate(id: string): StarterTemplate | undefined {
  return ALL_STARTER_TEMPLATES.find((t) => t.id === id);
}

/**
 * Get starter templates filtered by document type.
 */
export function getStarterTemplatesByType(documentType: string): StarterTemplate[] {
  return ALL_STARTER_TEMPLATES.filter((t) => t.documentType === documentType);
}
