# Task Ownership & Control

This document defines how tasks are visible and controlled by providers and clients.

---

## Core Principle

**Clients can observe task state and participate in discussion, but task state changes are provider-owned.**

---

## Client Capabilities

Clients can:
- View tasks and their current status
- Comment on tasks
- Answer questions
- Provide context
- Submit new task requests
- Approve or reject when approval is required

---

## Client Limitations (By Design)

Clients cannot:
- Move tasks between columns
- Change task status
- Reorder priorities
- Mark tasks complete
- Implicitly change scope

Influence happens through communication, not control.

---

## Provider Capabilities

Providers can:
- Create and edit tasks
- Change task status
- Reprioritize work
- Split or merge tasks
- Manage workflow and sequencing

---

## Why This Exists

This separation:
- Prevents accidental scope changes
- Reduces confusion
- Keeps ownership clear
- Scales cleanly to small teams

Clients get visibility without cognitive burden.

---

## Summary

Participation does not require control.

This model keeps collaboration clear and calm.