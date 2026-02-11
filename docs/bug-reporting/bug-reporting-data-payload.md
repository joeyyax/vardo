# Bug Reporting Payload

This document defines the minimum payload captured by the bug reporting overlay.

---

## Required Fields

- organization_id
- client_id
- project_id
- reporting_user_id
- page_url
- timestamp
- description (user-provided)

---

## Automatically Captured Metadata

- Screenshot (full page or viewport)
- DOM selector / XPath
- Viewport size
- Browser name + version
- OS
- User agent
- Referrer
- Theme or build identifier (if available)
- Feature flags (if applicable)

---

## Storage Notes

- Screenshot stored in R2
- Metadata stored as JSON
- Linked to request record
- Immutable after submission

---

## Summary

The payload favors debugging usefulness over verbosity.