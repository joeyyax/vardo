# review

Dispatch review skills for PR #$ARGUMENTS.

## What this does

Reads the PR's labels and runs the matching review skills. Acts as the entry point for all PR reviews.

## Steps

1. **Get PR metadata.** Run `gh pr view $ARGUMENTS --json labels,files,title,body` to read the PR's labels and changed files.

2. **Map labels to skills.** Match each `review:*` label to its skill:

   | Label | Skill |
   |-------|-------|
   | `review:security` | `/review-security` |
   | `review:architecture` | `/review-architecture` |
   | `review:frontend` | `/review-frontend` |
   | `review:database` | `/review-database` |
   | `review:performance` | `/review-performance` |
   | `review:final` | `/review-final` |
   | `review:docs` | `/review-docs` |
   | `review:testing` | `/review-testing` |
   | `review:full` | All gating reviews (security, architecture, frontend, database, performance) |

3. **Handle missing labels.** If the PR has no `review:*` labels, treat it as `review:full` -- run all gating reviews.

4. **Suggest additional reviews.** After mapping labels, scan the changed files and suggest reviews that might be missing:
   - Files in `lib/db/` or migration files --> suggest `review:database` if not already labeled
   - Files in `components/` or `app/` with JSX --> suggest `review:frontend` if not already labeled
   - Files in `app/api/` or server actions --> suggest `review:security` if not already labeled
   - New dependencies in `package.json` --> suggest `review:performance` if not already labeled

   Post suggestions as a comment: `gh pr comment $ARGUMENTS --body "..."`. Don't add labels automatically -- just suggest.

5. **Run the reviews.** Execute each matched skill in sequence, passing the PR number. Run gating reviews first, then generative reviews.

   The order for gating reviews:
   1. `review-security`
   2. `review-database`
   3. `review-architecture`
   4. `review-performance`
   5. `review-frontend`

   Then generative reviews:
   6. `review-docs`
   7. `review-testing`

   Then the final gate (only if explicitly labeled):
   8. `review-final`

6. **Post summary.** After all reviews complete, post a summary comment listing which reviews ran and their outcomes.
