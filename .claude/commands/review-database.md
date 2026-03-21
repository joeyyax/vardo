# review-database

Database review for PR #$ARGUMENTS.

## What this checks

Gating review. Must pass before merge.

- **Schema design** -- are tables normalized appropriately? Are column types correct? Are nullable columns intentional? Are foreign keys and cascades set up right?
- **Indexes** -- are queries backed by indexes? Are there missing indexes on foreign keys, frequently filtered columns, or compound query patterns?
- **Migration safety** -- can the migration run without downtime? Are there destructive operations (DROP COLUMN, DROP TABLE) that need a multi-step rollout? Are defaults set for new NOT NULL columns?
- **Query patterns** -- are queries using Drizzle's query builder correctly? Any raw SQL that should be parameterized? Any overly complex joins that could be simplified?
- **Data integrity** -- are constraints enforced at the database level, not just application level? Are there race conditions in read-then-write patterns?
- **N+1 queries** -- are there loops that execute individual queries instead of batching? Are relations loaded eagerly when needed?
- **Multi-tenancy** -- are all queries scoped by `organization_id`? Could a user access another org's data through this change?
- **Drizzle conventions** -- are schema changes using the project's established Drizzle patterns? Are `relations` exports updated when schema changes?

## Voice

Write as Joey. Casual, direct, em dashes for asides. Contractions always. No filler, no hedging, no sign-offs. State findings plainly -- if something's fine, don't mention it. Only flag what matters.

Use this structure for findings:
- Lead with severity (critical / warning / note)
- Name the file and line
- Say what's wrong and why it matters
- Suggest the fix in one sentence

If nothing is found, say so in one line. Don't pad the review.

## Steps

1. **Load past learnings.** Read `host/review-learnings/database` from the knowledge server via `knowledge_read`. Check what was missed in past reviews -- actively look for those patterns in this diff.

2. **Get the diff.** Run `gh pr diff $ARGUMENTS` to get the full PR diff. Also run `gh pr view $ARGUMENTS --json title,body,labels,files` for context.

3. **Review the diff.** Walk through every changed file. For each change, check every item in the checklist above. Pay special attention to:
   - Files in `lib/db/` -- schema changes, new queries, migration files
   - Server actions and API routes -- how they query the database
   - Any file that imports from `@/lib/db` -- check query patterns
   - New tables or columns -- do they have appropriate constraints and indexes?

4. **Post findings.** Run `gh pr review $ARGUMENTS --comment --body "..."` with your findings. Format as a markdown checklist grouped by severity. Prefix the comment with `## Database review`.

5. **Log learnings.** Write a summary of what you found (or didn't find) to the knowledge server at `host/review-learnings/database` via `knowledge_write`. Include the PR number, date, and any new patterns worth watching for.

6. **Self-evaluate.** Before posting, ask yourself: "What did I miss in past reviews that I should check for now?" Cross-reference the learnings from step 1.
