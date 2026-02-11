# Use when adding cron jobs, auto-generation, recurring logic.

You are adding automation.

Automation must:
- support human judgment
- reduce busywork
- never start work implicitly
- never change scope silently

Automation must not:
- advance lifecycle states
- create billable work without intent
- surprise the client

If automation introduces ambiguity, stop and redesign.