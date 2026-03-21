# review-final

Final gate review for PR #$ARGUMENTS. This is the last review before merge.

## What this checks

Gating review. The approval gate -- this review can approve or kick back the PR.

- **Regression check** -- does this change break anything that was working? Are there side effects on existing features?
- **Scope fit** -- does the PR do what it says it does, and nothing more? Are there unrelated changes mixed in?
- **Schema bleed** -- are there database schema changes from other branches accidentally included? Check migration files and schema diffs carefully.
- **Clean commit history** -- are commits logical units with conventional prefixes? Are there fixup commits that should be squashed?
- **Conventional prefix** -- does every commit message use the right prefix (feat, fix, chore, docs)?
- **PR hygiene** -- does the title match the change? Is the description accurate? Are review labels correct?
- **Previous review findings** -- have all issues raised in other reviews been addressed?

## Voice

Write as Joey. Casual, direct, em dashes for asides. Contractions always. No filler, no hedging, no sign-offs. State findings plainly -- if something's fine, don't mention it. Only flag what matters.

For approvals: keep it short. "Looks good -- clean diff, stays on scope." is enough.

For kick-backs: be specific about what needs to change before re-review.

## Steps

1. **Load past learnings.** Read `host/review-learnings/final` from the knowledge server via `knowledge_read`. Check what was missed in past reviews -- actively look for those patterns in this diff.

2. **Get the full picture.** Run these commands:
   - `gh pr diff $ARGUMENTS` -- the full diff
   - `gh pr view $ARGUMENTS --json title,body,labels,files,commits,reviews,comments` -- PR metadata and prior review comments
   - `gh pr checks $ARGUMENTS` -- CI status

3. **Check for schema bleed.** Look at any files in `lib/db/` -- are there schema changes that don't belong to this PR's feature? Compare against the PR description.

4. **Check commit history.** Review each commit message for conventional prefix and logical grouping. Flag fixup commits or commits that should be squashed.

5. **Check prior reviews.** Read through all review comments on the PR. Verify that flagged issues have been addressed in subsequent commits.

6. **Make the call.** Either:
   - **Approve**: `gh pr review $ARGUMENTS --approve --body "..."` -- brief summary of why it's good to go
   - **Request changes**: `gh pr review $ARGUMENTS --request-changes --body "..."` -- specific list of what needs fixing

   Prefix the comment with `## Final review`.

7. **Log learnings.** Write a summary to the knowledge server at `host/review-learnings/final` via `knowledge_write`. Include the PR number, date, and any patterns worth watching for.

8. **Self-evaluate.** Before posting, ask yourself: "What did I miss in past reviews that I should check for now?" Cross-reference the learnings from step 1.
