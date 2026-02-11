You are building a lightweight on-site bug reporting overlay for a Next.js SaaS app.

Context:
- This is part of a freelancer-focused project management system
- The overlay is NOT a PM tool
- It is a request intake mechanism only
- Clients must not be able to control workflow or task state

High-level requirements:

1. The overlay is delivered as a small JS embed:
   - <script src="..."></script>
   - No browser extensions
   - No iframe-based UI unless necessary

2. Activation:
   - Overlay only appears when:
     - user is authenticated in the client portal OR
     - a signed token is present
   - Must not appear for public users
   - Toggleable via a small floating button or keyboard shortcut

3. Interaction model:
   - Enter “inspect mode” on activation
   - Hover highlights DOM elements
   - Click selects an element
   - Capture a stable selector (XPath or CSS)
   - Capture screenshot
   - Open a minimal panel for description input
   - Single primary action: Submit

4. UI constraints:
   - Minimal footprint
   - No draggable panels
   - No lists or dashboards
   - No configuration UI
   - Disappears immediately after submission

5. Data captured automatically:
   - Page URL
   - Screenshot
   - DOM selector
   - Viewport size
   - Browser + OS
   - Timestamp
   - Reporting user identity
   - Project + client context

6. Submission behavior:
   - POST to /api/v1/organizations/:orgId/requests
   - Creates a request in `requested` or `needs-review` state
   - Does NOT create a task automatically
   - Provider must triage

7. Non-goals (do NOT build):
   - Task boards
   - Status management
   - Client priority selection
   - Severity dropdowns
   - Multi-step flows

8. Code expectations:
   - Clean, readable TypeScript
   - Small surface area
   - Progressive enhancement
   - Easy to disable or remove
   - No global pollution

Deliverables:
- Overlay JS module
- Minimal CSS
- Clear separation between UI, capture logic, and submission
- Notes on selector stability and screenshot approach

Build this to feel invisible, fast, and respectful of the page it runs on.