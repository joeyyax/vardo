# review-frontend

Frontend review for PR #$ARGUMENTS.

## What this checks

Gating review. Must pass before merge.

- **Component patterns** -- are components following shadcn/ui conventions? Are they using the `squircle` class where appropriate? Are client/server component boundaries correct?
- **Performance** -- unnecessary re-renders from unstable references, missing `useMemo`/`useCallback` where it matters, large components that should be split, unoptimized images
- **Accessibility** -- missing labels, roles, aria attributes. Interactive elements without keyboard support. Color contrast issues. Missing focus management.
- **Responsive design** -- does the layout work across breakpoints? Are there hardcoded widths or heights that break on mobile?
- **Design system compliance** -- are colors, spacing, typography using design tokens? Any magic numbers or one-off styles?
- **Loading and error states** -- are async operations showing loading indicators? Are errors caught and displayed? Are empty states handled?
- **Client bundle** -- are server-only imports accidentally pulled into client components? Are large libraries imported without tree-shaking?

## Voice

Write as Joey. Casual, direct, em dashes for asides. Contractions always. No filler, no hedging, no sign-offs. State findings plainly -- if something's fine, don't mention it. Only flag what matters.

Use this structure for findings:
- Lead with severity (critical / warning / note)
- Name the file and line
- Say what's wrong and why it matters
- Suggest the fix in one sentence

If nothing is found, say so in one line. Don't pad the review.

## Steps

1. **Load past learnings.** Read `host/review-learnings/frontend` from the knowledge server via `knowledge_read`. Check what was missed in past reviews -- actively look for those patterns in this diff.

2. **Get the diff.** Run `gh pr diff $ARGUMENTS` to get the full PR diff. Also run `gh pr view $ARGUMENTS --json title,body,labels,files` for context.

3. **Review the diff.** Walk through every changed file. For each change, check every item in the checklist above. Pay special attention to:
   - New components -- do they follow the component patterns already in the codebase?
   - `"use client"` directives -- are they at the right boundary, or too high up the tree?
   - Event handlers -- are they stable references, or recreated every render?
   - Imports from `@/components/ui` -- are they using shadcn primitives correctly?
   - Sonner toast usage -- following the project's toast patterns?

4. **Post findings.** Run `gh pr review $ARGUMENTS --comment --body "..."` with your findings. Format as a markdown checklist grouped by severity. Prefix the comment with `## Frontend review`.

5. **Log learnings.** Write a summary of what you found (or didn't find) to the knowledge server at `host/review-learnings/frontend` via `knowledge_write`. Include the PR number, date, and any new patterns worth watching for.

6. **Self-evaluate.** Before posting, ask yourself: "What did I miss in past reviews that I should check for now?" Cross-reference the learnings from step 1.
