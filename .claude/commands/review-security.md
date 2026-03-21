# review-security

Security review for PR #$ARGUMENTS.

## What this checks

Gating review. Must pass before merge.

- **Injection** -- SQL injection via raw queries or string interpolation, command injection via exec/spawn, XSS via dangerouslySetInnerHTML or unescaped output
- **Auth gaps** -- missing auth checks on API routes, org-scoping bypasses, privilege escalation paths
- **Secret exposure** -- hardcoded credentials, API keys, tokens in client bundles or logs
- **Rate limiting** -- unprotected endpoints that accept unbounded input (login, signup, forgot-password, API routes)
- **Input validation** -- missing or incomplete Zod schemas, unvalidated path params, unchecked file uploads
- **Headers** -- missing CSRF protection, permissive CORS, absent security headers
- **Dependencies** -- known CVEs in direct deps, unnecessary permissions

## Voice

Write as Joey. Casual, direct, em dashes for asides. Contractions always. No filler, no hedging, no sign-offs. State findings plainly -- if something's fine, don't mention it. Only flag what matters.

Use this structure for findings:
- Lead with severity (critical / warning / note)
- Name the file and line
- Say what's wrong and why it matters
- Suggest the fix in one sentence

If nothing is found, say so in one line. Don't pad the review.

## Steps

1. **Load past learnings.** Read `host/review-learnings/security` from the knowledge server via `knowledge_read`. Check what was missed in past reviews -- actively look for those patterns in this diff.

2. **Get the diff.** Run `gh pr diff $ARGUMENTS` to get the full PR diff. Also run `gh pr view $ARGUMENTS --json title,body,labels,files` for context.

3. **Review the diff.** Walk through every changed file. For each change, check every item in the checklist above. Pay special attention to:
   - Server actions and API route handlers -- are they authed and org-scoped?
   - Database queries -- are they parameterized via Drizzle, or raw?
   - Client components -- do they render user input safely?
   - Environment variable usage -- are secrets kept server-side?
   - New dependencies -- do they have known vulnerabilities?

4. **Post findings.** Run `gh pr review $ARGUMENTS --comment --body "..."` with your findings. Format as a markdown checklist grouped by severity. Prefix the comment with `## Security review`.

5. **Log learnings.** Write a summary of what you found (or didn't find) to the knowledge server at `host/review-learnings/security` via `knowledge_write`. Include the PR number, date, and any new patterns worth watching for.

6. **Self-evaluate.** Before posting, ask yourself: "What did I miss in past reviews that I should check for now?" Cross-reference the learnings from step 1.
