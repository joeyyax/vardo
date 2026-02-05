# Expanded Tasks Design

## Overview

Transform the simple task model into a full project management system with task types, relationships, discussions, notifications, and activity tracking. Serves two audiences: internal team (full access) and clients (filtered view).

---

## Data Model

### Task Types (Organization-defined)

```sql
CREATE TABLE task_types (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,              -- "Bug", "Feature", "Task"
  color TEXT,                      -- Hex color for visual distinction
  icon TEXT,                       -- Icon identifier (e.g., "bug", "lightbulb")
  default_fields JSONB,            -- Which fields to show: { "severity": true, "steps_to_reproduce": true }
  position INTEGER DEFAULT 0,      -- Sort order in dropdowns
  is_archived BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(organization_id, name)
);
```

### Task Tags (Organization-defined, hybrid creation)

```sql
CREATE TABLE task_tags (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT,
  is_predefined BOOLEAN DEFAULT true,  -- false = created ad-hoc, can be promoted
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(organization_id, name)
);

CREATE TABLE task_tag_assignments (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id UUID NOT NULL REFERENCES task_tags(id) ON DELETE CASCADE,
  PRIMARY KEY (task_id, tag_id)
);
```

### Task Relationships

```sql
CREATE TABLE task_relationships (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  target_task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  type TEXT NOT NULL,  -- 'blocked_by', 'related_to'
  created_by TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  UNIQUE(source_task_id, target_task_id, type)
);
```

**Relationship semantics:**
- `blocked_by`: Source task cannot complete until target task is done
- `related_to`: Informational link, no enforcement

### Task Files (Links to project files)

```sql
CREATE TABLE task_files (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  file_id UUID NOT NULL REFERENCES project_files(id) ON DELETE CASCADE,
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (task_id, file_id)
);
```

Files uploaded "to a task" go to project_files with automatic link here.

### Task Comments (Internal by default)

```sql
CREATE TABLE task_comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id),
  content TEXT NOT NULL,              -- Markdown supported
  is_shared BOOLEAN DEFAULT false,    -- false = internal, true = client-visible
  shared_at TIMESTAMP,                -- When shared (audit trail)
  shared_by TEXT REFERENCES users(id),
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Expanded Tasks Table

Add columns to existing `tasks` table:

```sql
ALTER TABLE tasks ADD COLUMN type_id UUID REFERENCES task_types(id) ON DELETE SET NULL;
ALTER TABLE tasks ADD COLUMN estimate_minutes INTEGER;
ALTER TABLE tasks ADD COLUMN pr_link TEXT;
ALTER TABLE tasks ADD COLUMN is_client_visible BOOLEAN DEFAULT true;
ALTER TABLE tasks ADD COLUMN metadata JSONB DEFAULT '{}';
```

**Field descriptions:**
- `type_id`: Bug, Feature, Task, etc.
- `estimate_minutes`: Single time estimate
- `pr_link`: GitHub/GitLab PR URL (text field, no integration)
- `is_client_visible`: Hide entire task from client portal
- `metadata`: Type-specific fields (severity, steps_to_reproduce, etc.)

---

## Notifications

### User Preferences

```sql
CREATE TABLE notification_preferences (
  user_id TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  assigned_to_you BOOLEAN DEFAULT true,
  mentioned BOOLEAN DEFAULT true,
  watched_task_changed BOOLEAN DEFAULT true,
  blocker_resolved BOOLEAN DEFAULT true,
  client_comment BOOLEAN DEFAULT true,
  email_enabled BOOLEAN DEFAULT true,
  created_at TIMESTAMP DEFAULT NOW(),
  updated_at TIMESTAMP DEFAULT NOW()
);
```

### Task Watchers

```sql
CREATE TABLE task_watchers (
  task_id UUID NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  reason TEXT,  -- 'creator', 'assignee', 'commenter', 'manual'
  created_at TIMESTAMP DEFAULT NOW(),
  PRIMARY KEY (task_id, user_id)
);
```

**Auto-watch rules:**
- Creating a task: add watcher with reason 'creator'
- Assigned to task: add watcher with reason 'assignee'
- Commenting on task: add watcher with reason 'commenter'
- Manual watch: add with reason 'manual'

Users can unwatch any task regardless of reason.

### Notifications Inbox

```sql
CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,
  actor_id TEXT REFERENCES users(id),
  content TEXT,
  is_read BOOLEAN DEFAULT false,
  email_sent BOOLEAN DEFAULT false,
  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_notifications_user ON notifications(user_id, is_read, created_at DESC);
```

**Notification types:**
- `assigned` - Task assigned to you
- `mentioned` - @mentioned in a comment
- `status_changed` - Watched task status changed
- `comment` - New comment on watched task
- `blocker_resolved` - Task blocking yours completed
- `client_comment` - Client added a shared comment

---

## Global Activity Log

Replaces existing `project_activities` with unified system.

```sql
CREATE TABLE activities (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,

  -- Who
  actor_id TEXT REFERENCES users(id),
  actor_type TEXT DEFAULT 'user',  -- 'user', 'client', 'system'

  -- What entity
  entity_type TEXT NOT NULL,  -- 'task', 'project', 'expense', 'invoice', 'document', 'time_entry'
  entity_id UUID NOT NULL,

  -- Parent context
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  task_id UUID REFERENCES tasks(id) ON DELETE CASCADE,

  -- What happened
  action TEXT NOT NULL,
  field TEXT,
  old_value TEXT,
  new_value TEXT,
  metadata JSONB,

  -- Visibility
  is_client_visible BOOLEAN DEFAULT false,

  created_at TIMESTAMP DEFAULT NOW()
);

CREATE INDEX idx_activities_org ON activities(organization_id, created_at DESC);
CREATE INDEX idx_activities_project ON activities(project_id, created_at DESC);
CREATE INDEX idx_activities_task ON activities(task_id, created_at DESC);
CREATE INDEX idx_activities_entity ON activities(entity_type, entity_id);
```

**Logged actions:**
- `created`, `updated`, `deleted`, `archived`
- `status_changed`, `assigned`, `unassigned`
- `estimate_changed`, `type_changed`
- `blocker_added`, `blocker_removed`, `blocker_resolved`
- `related_added`, `related_removed`
- `commented`, `comment_shared`
- `file_attached`, `file_removed`
- `visibility_changed`

**Contextual queries:**
- Task view: `WHERE task_id = ?`
- Project view: `WHERE project_id = ?`
- Global feed: `WHERE organization_id = ?`
- Client portal: add `AND is_client_visible = true`

---

## Behaviors

### Task Type Forms

Each task type can define which fields appear via `default_fields`:

```json
{
  "severity": true,
  "steps_to_reproduce": true,
  "environment": true
}
```

The UI reads this to render appropriate fields. Values stored in task `metadata`:

```json
{
  "severity": "high",
  "steps_to_reproduce": "1. Click login\n2. Enter wrong password\n3. See error",
  "environment": "Chrome 120, macOS"
}
```

### Blocking Enforcement

- Task with unresolved blockers shows "Blocked" badge
- Can move to any status except "Done"
- API rejects `status = 'done'` if blockers exist
- Returns error: `{ "error": "Blocked by tasks", "blockers": [...] }`
- When blocker completes, blocked tasks auto-unblock (system activity logged)
- Circular dependency check on relationship creation

### Client Visibility

Three layers:
1. **Task**: `is_client_visible = false` hides entire task
2. **Comment**: `is_shared = false` (default) = internal only
3. **Field**: PR link, estimates, rates always internal

Client portal queries filter by visibility flags.

### Watching

Auto-subscribe on:
- Create task (reason: 'creator')
- Assigned to you (reason: 'assignee')
- Comment on task (reason: 'commenter')

Manual watch/unwatch available on any task.

### Notification Delivery

1. Event occurs (status change, comment, etc.)
2. Find watchers for task
3. Filter by user preferences
4. Create notification record
5. If `email_enabled` and relevant pref is true, queue email
6. Email sent via Resend, mark `email_sent = true`

---

## Migration Notes

- Existing `project_activities` data should be migrated to new `activities` table
- Existing tasks need `is_client_visible` defaulted to `true`
- Create default task types for existing orgs: "Task", "Bug", "Feature"
- Notification preferences created on first access (lazy init)

---

## UI Components Needed

- Task type management (settings page)
- Tag management (settings page)
- Enhanced task dialog (type-specific fields, relationships, estimate)
- Task detail view (full width, comments, activity, files)
- Comment composer with share button
- Notification bell + dropdown
- Notification preferences page
- Activity timeline component (reusable across contexts)
- Blocker picker (search/select tasks)
- Related task picker
- Watch/unwatch button

---

## API Endpoints Needed

### Task Types
- `GET /api/v1/organizations/[orgId]/task-types`
- `POST /api/v1/organizations/[orgId]/task-types`
- `PATCH /api/v1/organizations/[orgId]/task-types/[id]`
- `DELETE /api/v1/organizations/[orgId]/task-types/[id]`

### Task Tags
- `GET /api/v1/organizations/[orgId]/task-tags`
- `POST /api/v1/organizations/[orgId]/task-tags`
- `PATCH /api/v1/organizations/[orgId]/task-tags/[id]`
- `DELETE /api/v1/organizations/[orgId]/task-tags/[id]`

### Task Relationships
- `GET /api/v1/organizations/[orgId]/tasks/[taskId]/relationships`
- `POST /api/v1/organizations/[orgId]/tasks/[taskId]/relationships`
- `DELETE /api/v1/organizations/[orgId]/tasks/[taskId]/relationships/[id]`

### Task Comments
- `GET /api/v1/organizations/[orgId]/tasks/[taskId]/comments`
- `POST /api/v1/organizations/[orgId]/tasks/[taskId]/comments`
- `PATCH /api/v1/organizations/[orgId]/tasks/[taskId]/comments/[id]`
- `POST /api/v1/organizations/[orgId]/tasks/[taskId]/comments/[id]/share`
- `DELETE /api/v1/organizations/[orgId]/tasks/[taskId]/comments/[id]`

### Task Files
- `GET /api/v1/organizations/[orgId]/tasks/[taskId]/files`
- `POST /api/v1/organizations/[orgId]/tasks/[taskId]/files`
- `DELETE /api/v1/organizations/[orgId]/tasks/[taskId]/files/[fileId]`

### Task Watchers
- `GET /api/v1/organizations/[orgId]/tasks/[taskId]/watchers`
- `POST /api/v1/organizations/[orgId]/tasks/[taskId]/watch`
- `DELETE /api/v1/organizations/[orgId]/tasks/[taskId]/watch`

### Notifications
- `GET /api/v1/users/me/notifications`
- `PATCH /api/v1/users/me/notifications/[id]/read`
- `POST /api/v1/users/me/notifications/mark-all-read`
- `GET /api/v1/users/me/notification-preferences`
- `PATCH /api/v1/users/me/notification-preferences`

### Activities
- `GET /api/v1/organizations/[orgId]/activities`
- `GET /api/v1/organizations/[orgId]/projects/[projectId]/activities`
- `GET /api/v1/organizations/[orgId]/tasks/[taskId]/activities`
