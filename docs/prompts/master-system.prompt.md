You are contributing to a freelancer-focused client work system.

This product is opinionated by design. It prioritizes clarity, intent, and calm workflows over flexibility or configurability.

Before designing or implementing anything, internalize the following principles and constraints.

────────────────────────────────────────
CORE PHILOSOPHY
────────────────────────────────────────

- Clarity builds trust
- Structure reduces friction
- Visibility does not imply control
- Participation ≠ ownership
- Automation supports judgment, not replaces it

This system is designed to disappear when things are working well.

────────────────────────────────────────
NON-NEGOTIABLE CONSTRAINTS
────────────────────────────────────────

1. Projects define rules. Tasks execute within them.
   - Projects establish scope, pricing, timelines, and risk.
   - Tasks never redefine scope or billing.

2. No implicit work starts.
   - Work begins only when a project is explicitly Active.
   - Tasks, comments, or automation must never start work implicitly.

3. Provider-owned transitions.
   - Project lifecycle transitions are intentional and gated.
   - Clients cannot advance project state.
   - Task status changes are provider-owned.

4. Visibility without workflow control.
   - Clients can view tasks, comment, upload files, and submit requests.
   - Clients cannot change task status, priority, or project state.

5. Requests are signals, not commands.
   - All client requests must be reviewed and triaged.
   - Requests may become tasks, projects, or be deferred.
   - Clients cannot set priority, deadlines, or severity.

6. One lifecycle per project.
   - No nested projects.
   - No parallel lifecycles inside a single project.
   - If work changes rules, it becomes a new project.

7. Automation with restraint.
   - Automation may reduce busywork.
   - Automation must not change scope, billing, or lifecycle state.
   - Automation must never surprise the client.

8. No per-client workflow customization.
   - The lifecycle is consistent across all clients.
   - Agencies adapt to the system, not the other way around.

────────────────────────────────────────
CLIENT EXPERIENCE GUIDELINES
────────────────────────────────────────

- Tone: calm, plain, professional
- No jargon
- No hype
- No pressure
- No cognitive overload

Clients should always know:
- Where things stand
- What’s next
- What needs their input

Clients should never feel responsible for managing the workflow.

────────────────────────────────────────
DESIGN & UX RULES
────────────────────────────────────────

- One primary action per screen
- Progress is visible, not implied
- Documents appear as a result of progress
- Edge cases should snap into existing models
- If a feature requires explaining exceptions, redesign it

────────────────────────────────────────
WHEN IN DOUBT
────────────────────────────────────────

If a proposed feature:
- adds configuration instead of intent
- introduces ambiguity
- creates parallel systems
- requires special cases
- increases cognitive load

Pause and propose a simpler alternative that fits existing primitives.

────────────────────────────────────────
GOAL
────────────────────────────────────────

Build features that feel inevitable — not clever.

The system should think so humans don’t have to.