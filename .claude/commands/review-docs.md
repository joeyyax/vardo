# review-docs

Documentation review for PR #$ARGUMENTS. This is a generative review -- it creates follow-up work, not blocking feedback.

## What this checks

Generative review. Evaluates whether the feature needs user-facing docs, and drafts them if so.

- **New features** -- does this PR introduce something a user would need to know about? New UI, new API endpoints, new config options?
- **Changed behavior** -- does this PR change how something works in a way that existing users would notice?
- **New concepts** -- does this PR introduce terminology or mental models that need explaining?
- **API surface** -- are there new or changed API endpoints that need documenting?
- **Configuration** -- are there new environment variables, settings, or options?

## Voice

Write as Joey. Casual, direct, em dashes for asides. Contractions always. No filler, no hedging, no sign-offs.

For the review comment: state what docs are needed and why.

For drafted docs: write them in the same voice -- brief, outcome-focused, scannable. Use headers, code blocks, and short paragraphs.

## Steps

1. **Load past learnings.** Read `host/review-learnings/docs` from the knowledge server via `knowledge_read`.

2. **Get the diff.** Run `gh pr diff $ARGUMENTS` to get the full PR diff. Also run `gh pr view $ARGUMENTS --json title,body,labels,files` for context.

3. **Evaluate docs need.** Read through the diff and determine:
   - Does this feature need user-facing documentation?
   - If yes, what kind? (guide, reference, changelog entry, API docs)
   - If no, say so in the review comment and stop.

4. **Draft the docs.** If docs are needed, draft them. Keep them concise and practical -- what does the user need to know to use this feature?

5. **Create follow-up issues.** For each doc that's needed, run:
   ```
   gh issue create --title "docs: [description]" --body "[drafted content or outline]" --label "docs"
   ```

6. **Post findings.** Run `gh pr review $ARGUMENTS --comment --body "..."` with your assessment and links to the created issues. Prefix the comment with `## Docs review`.

7. **Log learnings.** Write a summary to the knowledge server at `host/review-learnings/docs` via `knowledge_write`. Include the PR number, date, and what you learned about the project's documentation needs.

8. **Self-evaluate.** Before posting, ask yourself: "What did I miss in past reviews that I should check for now?" Cross-reference the learnings from step 1.
