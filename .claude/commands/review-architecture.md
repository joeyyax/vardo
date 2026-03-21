# review-architecture

Architecture review for PR #$ARGUMENTS.

## What this checks

Gating review. Must pass before merge.

- **Patterns** -- does the code follow established patterns in the codebase? Server actions, API routes, Drizzle queries, component structure -- are they consistent with what's already there?
- **Duplication** -- is logic duplicated that should be extracted? Conversely, is something over-abstracted that should just be inlined?
- **Ports and adapters** -- are infrastructure concerns (database, auth, external APIs) behind clean boundaries? Or is Drizzle leaking into components?
- **Separation of concerns** -- are server and client responsibilities clear? Is business logic in the right layer?
- **Type safety** -- are types flowing end-to-end? Any `any` types, type assertions, or missing return types on public functions?
- **Dead code** -- unused imports, unreachable branches, commented-out blocks, orphaned files
- **Dependency direction** -- do dependencies point inward (UI -> domain -> infra), or is there a cycle?
- **Module boundaries** -- does this change respect bounded context boundaries, or does it reach across them?

## Voice

Write as Joey. Casual, direct, em dashes for asides. Contractions always. No filler, no hedging, no sign-offs. State findings plainly -- if something's fine, don't mention it. Only flag what matters.

Use this structure for findings:
- Lead with severity (critical / warning / note)
- Name the file and line
- Say what's wrong and why it matters
- Suggest the fix in one sentence

If nothing is found, say so in one line. Don't pad the review.

## Steps

1. **Load past learnings.** Read `host/review-learnings/architecture` from the knowledge server via `knowledge_read`. Check what was missed in past reviews -- actively look for those patterns in this diff.

2. **Get the diff.** Run `gh pr diff $ARGUMENTS` to get the full PR diff. Also run `gh pr view $ARGUMENTS --json title,body,labels,files` for context.

3. **Understand the codebase context.** For any files touched in the diff, read the surrounding directory to understand existing patterns. Don't review in isolation -- compare against how similar things are already done.

4. **Review the diff.** Walk through every changed file. For each change, check every item in the checklist above. Pay special attention to:
   - New files -- do they follow the established directory structure and naming conventions?
   - New abstractions -- do they earn their complexity? Would a simpler approach work?
   - Cross-cutting changes -- do they touch too many bounded contexts at once?
   - Import paths -- are they reaching across module boundaries inappropriately?

5. **Post findings.** Run `gh pr review $ARGUMENTS --comment --body "..."` with your findings. Format as a markdown checklist grouped by severity. Prefix the comment with `## Architecture review`.

6. **Log learnings.** Write a summary of what you found (or didn't find) to the knowledge server at `host/review-learnings/architecture` via `knowledge_write`. Include the PR number, date, and any new patterns worth watching for.

7. **Self-evaluate.** Before posting, ask yourself: "What did I miss in past reviews that I should check for now?" Cross-reference the learnings from step 1.
