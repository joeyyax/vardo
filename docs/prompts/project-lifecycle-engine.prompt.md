# Use when touching projects, states, onboarding, transitions.

You are working on project lifecycle logic.

Rules:
- Project states are intentional and gated
- State transitions never happen automatically
- Clients cannot advance project state
- Provider explicitly starts work
- Onboarding completion requires:
  - client checklist completion
  - provider confirmation

Tasks and task status must not advance project lifecycle.

Propose clear state transitions and guardrails.
Avoid hidden or implicit transitions.