# review-performance

Performance review for PR #$ARGUMENTS.

## What this checks

Gating review. Must pass before merge.

- **Bundle size** -- are new dependencies justified? Are they tree-shakeable? Are large libraries imported where a lighter alternative exists? Are server-only deps leaking into client bundles?
- **Query efficiency** -- are database queries fetching only what's needed? Are there SELECT * patterns? Are aggregations done in the database or in JS?
- **Caching** -- are expensive operations cached? Are cache keys correct? Are there stale cache risks? Is `unstable_cache` or `revalidatePath` used appropriately?
- **Hot paths** -- are frequently-called functions doing unnecessary work? Are there synchronous operations that should be async? Are there blocking calls in request handlers?
- **Unnecessary work** -- redundant computations, duplicate API calls, fetching data that's already available, re-computing derived state
- **N+1 patterns** -- loops with individual queries, waterfall requests, sequential awaits that could be parallel
- **Image and asset optimization** -- are images using Next.js Image component? Are assets appropriately sized? Are fonts loaded efficiently?
- **Server vs client** -- is work happening on the client that should happen on the server (or vice versa)?

## Voice

Write as Joey. Casual, direct, em dashes for asides. Contractions always. No filler, no hedging, no sign-offs. State findings plainly -- if something's fine, don't mention it. Only flag what matters.

Use this structure for findings:
- Lead with severity (critical / warning / note)
- Name the file and line
- Say what's wrong and why it matters
- Suggest the fix in one sentence

If nothing is found, say so in one line. Don't pad the review.

## Steps

1. **Load past learnings.** Read `host/review-learnings/performance` from the knowledge server via `knowledge_read`. Check what was missed in past reviews -- actively look for those patterns in this diff.

2. **Get the diff.** Run `gh pr diff $ARGUMENTS` to get the full PR diff. Also run `gh pr view $ARGUMENTS --json title,body,labels,files` for context.

3. **Review the diff.** Walk through every changed file. For each change, check every item in the checklist above. Pay special attention to:
   - New `import` statements -- what's being pulled in, and how big is it?
   - Database queries -- are they efficient? Could they be batched?
   - `useEffect` and `useState` -- are they causing unnecessary work?
   - API route handlers -- are they doing sequential work that could be parallel?
   - `Promise.all` vs sequential `await` -- are independent operations parallelized?

4. **Post findings.** Run `gh pr review $ARGUMENTS --comment --body "..."` with your findings. Format as a markdown checklist grouped by severity. Prefix the comment with `## Performance review`.

5. **Log learnings.** Write a summary of what you found (or didn't find) to the knowledge server at `host/review-learnings/performance` via `knowledge_write`. Include the PR number, date, and any new patterns worth watching for.

6. **Self-evaluate.** Before posting, ask yourself: "What did I miss in past reviews that I should check for now?" Cross-reference the learnings from step 1.
