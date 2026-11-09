# Pull request panel: the complete read-only view

Date: 2026-11-09. Follows `initial-plugin` (pull request #1). Bas Nijholt asked for "a more complete read-only view" after choosing to leave GitHub writes (merge, review, comment) out for now.

## Goal

The side panel shows everything T3 Code's pull request panel shows that only reads: the checks, the reviewers and their verdicts, labels, merge and base state, the conversation, a Timeline tab, review comments inline in the diffs, a commit selector, and the Code tab's display controls. Nothing writes to GitHub. Local UI state (viewed marks, toggles) stays in the browser.

Success: on a pull request with checks, reviews, inline review comments and several commits, every item below shows; with no token, the panel still works on public pull requests within GitHub's 60 requests an hour.

## Sources

T3 Code at `8ab427c6`, MIT, under `apps/web/src/components/pullRequest/` unless named: `PullRequestDetailPanel.tsx` (header), `PullRequestDetailCrumbs.tsx`, `PullRequestBaseBranch.tsx`, `PullRequestChangeBreakdownStat.tsx`, `PullRequestDetailActions.tsx` (its read-only badges only), `PullRequestChecksPopover.tsx`, `pullRequestPresentation.tsx` (checks, review outcome, label chip, actor label), `PullRequestSummaryTab.tsx`, `PullRequestTimelineTab.tsx`, `PullRequestReviewAnnotation.tsx` (display part), `PullRequestReactions.tsx` (display part), `PullRequestMoreReplies.tsx`, `PullRequestCommentBody.tsx`, `pullRequestDetail.logic.ts` (conversation, timeline, checks grouping, review outcomes, base freshness), `pullRequestDiff.logic.ts`, `pullRequestFileOrder.logic.ts`, `PullRequestCodeTab.tsx` (annotations, off-diff threads, commit selector, viewed marks, toggles), `packages/shared/src/changedFileKind.ts`, and `apps/web/src/lib/diffRendering.ts` (`hideWhitespaceChanges`). Ported files keep the port header line; their logic tests are ported with them.

Left out: everything that writes (merge, approve, comment, edit, pickers, resolve, ready for review, workflow approval), T3's Guide tab, pull request stacks, linked threads, and T3's own virtualization library (the lists here page instead).

## Data (GitHub REST, `api.github.com` only, as today)

Each query loads when the part that shows it first renders, through the app's `QueryClient`, with a 2-minute stale time (up from 60 s, to stay inside the anonymous limit).

| Query | Endpoint | Shown in |
|---|---|---|
| pull request (exists) | `GET /repos/{o}/{r}/pulls/{n}`, now also `labels`, `requested_reviewers`, `mergeable_state`, `auto_merge`, `head.sha`, `head.repo.full_name`, `merged_at`, `closed_at`, `comments`, `review_comments`, `commits` | header, Summary |
| checks | `GET /repos/{o}/{r}/commits/{head sha}/check-runs?per_page=100` and `GET .../commits/{head sha}/status` (commit statuses), merged into one list | header, Summary |
| base comparison | `GET /repos/{o}/{r}/compare/{base ref}...{head sha}` (`behind_by` only; the response's files are ignored) | header |
| reviews | `GET .../pulls/{n}/reviews?per_page=100`, paged | Summary, Timeline, header approvals |
| conversation comments | `GET /repos/{o}/{r}/issues/{n}/comments?per_page=100`, paged | Summary, Timeline |
| review comments | `GET .../pulls/{n}/comments?per_page=100`, paged | Summary, Timeline, Code |
| commits | `GET .../pulls/{n}/commits?per_page=100` (GitHub lists 250 at most) | Timeline, Code commit selector |
| files (exists) | `GET .../pulls/{n}/files` | Code |
| one commit's files | `GET /repos/{o}/{r}/commits/{sha}` (its `files`, same shape as the pull request's) | Code, when a commit is chosen |

Paging stops at 10 pages per list; when a list was cut short, the panel says "Showing the first N; see the rest on GitHub" with a link. Reactions come from each comment's `reactions` summary (counts per emoji, no names: REST does not say who reacted).

REST has no "resolved" flag for review threads and no GitHub-side "viewed" state for files (both are GraphQL, which needs a token even for public repositories). Threads therefore show as open, and outdated (`position` null) ones say "Outdated"; viewed marks are local (below). A GraphQL path for signed-in users is a later step.

A review thread is a root review comment (`in_reply_to_id` null) and its replies (`in_reply_to_id` = the root's `id`), sorted by `created_at`.

Without a token, a panel showing the header and Summary costs 7 requests when each list fits one page (pull request, check runs, statuses, comparison, reviews, conversation comments, review comments); Timeline adds commits; Code adds the files. The token form's hint, shown on the rate-limited state, already offers a token.

## Header (additions to today's)

Ported from `PullRequestDetailPanel.tsx`'s header and its parts:

- Crumbs: the repository links to it on GitHub; `#number` links to the pull request, in the state's color (open, draft, closed, merged).
- Meta line: the author opens their GitHub profile, with a tooltip "name (@login)" when GitHub gives a name; "updated <relative time>"; a copy button for the checkout command `gh pr checkout <n> -R <owner>/<repo>`.
- Branch line: the base branch, with a warning icon and a popover "<head> is <N> commits behind <base>" when `behind_by > 0`, and "This branch has conflicts that must be resolved" when `mergeable_state` is `dirty`; the head branch, with its owner prefix when it comes from a fork (`head.repo.full_name` differs).
- Badges: "Draft", "Merged" or "Closed" (state), and "Auto-merge (<method>)" when `auto_merge` is set.
- The `+/-` stat's tooltip splits the lines into Code, Tests, Generated and Docs with a Total, computed from the files once the Code tab has loaded them, and loading them on first hover otherwise (`changedFileKind.ts` decides the kind).
- Tab bar: Summary, Timeline, Code. On Summary its end shows the checks status line (icon and summary text, such as "2 of 9 failing", "All checks have passed", "3 of 9 running"), which opens the checks popover. On Timeline it shows the comment count, the commit count and the approvals count, and a Newest/Oldest first toggle.

## Checks popover

Port of `PullRequestChecksPopover.tsx`: the overall label and summary; a grid of icon, name (tooltip: description or output title), status label and "Details" link; failing, cancelled and action-required first, then running, with completed ones behind "Show all" when either of those groups has entries. Check runs map `status`/`conclusion` to pending (queued, in_progress, waiting, requested, pending), action-required (`action_required`), success, failure (failure, timed_out, startup_failure), cancelled, skipped, neutral (neutral, stale); commit statuses map `pending`, `success`, `failure`/`error`. A check run and a status with the same name: the newer wins.

## Summary tab

Port of `PullRequestSummaryTab.tsx`, display only:

- Reviewers row: overlapping avatars with a ring and corner glyph for each reviewer's latest verdict (approved, changes requested; commented and dismissed reviews give no verdict), faded with "Approved earlier changes" when the review's `commit_id` is not the head; requested reviewers who have not reviewed show plain. Teams in `requested_teams` show as their name.
- Labels row: colored chips from `labels[{ name, color }]`.
- Description: as today, in a collapsible section with a sticky heading.
- Checks section, collapsed by default: one row per check with icon, name, status label and link.
- Comments section, "Comments (N)": conversations built as T3's `pullRequestConversationItems` builds them, from conversation comments, review threads, and reviews with a body; a filter menu (show bots, kept in plugin storage), a Newest/Oldest toggle, 10 conversations at a time ("Show N older conversations"). A comment card: author, relative time linking to the comment on GitHub (absolute time in the tooltip), the verdict badge for a review, `path:line` and "Outdated" for a thread, reaction pills, the body as Markdown clamped at 240 px with "Show full comment", replies indented. Bodies render through the SDK's `useMarkdownHtml`.

## Timeline tab

Port of `PullRequestTimelineTab.tsx` and `buildPullRequestTimeline`: opened, one event per commit (headline, short SHA, time, author avatar; choosing it opens the Code tab on that commit), reviews with a verdict, review threads (expanded), runs of plain comments grouped into one collapsed "N comments · M authors" row that expands, and merged or closed. A vertical connector line, newest first by default, and "No activity yet." when there is nothing.

## Code tab (additions to today's)

- Inline review threads: threads grouped by path and by `side:line` become `@pierre/diffs` line annotations when the line falls inside a rendered hunk; the card (port of `ReviewThreadCard`'s display part) shows "N comments", "Outdated", each comment's avatar, login, time, reactions and Markdown body, expanded by default, collapsible. Threads whose line is not in the diff (or every thread, on a single commit's view) go in a collapsible "Conversations not on the current diff (N)" bar above the diffs, grouped by path.
- Commit selector: "All commits" and the commits newest first (headline, short SHA), 10 at a time with "Show more (N left)"; choosing one shows that commit's diff; a SHA that is gone after a force push falls back to All commits.
- Viewed marks, local: a checkbox in each file's header, kept per pull request in plugin storage as the path and a hash of the file's patch; a file whose patch changed since shows "Changed" in the warning color; "X / N viewed" in the toolbar; marking a file viewed collapses it; Shift-click marks a range.
- Display controls in the toolbar, kept in plugin storage: hide test files (with "N test files hidden"), ignore whitespace (T3's `hideWhitespaceChanges`), split or unified, wrap lines, collapse or expand all.
- File order: T3's `orderDiffFiles` (source files with what they import first, each test next to its source, generated files and lockfiles last), then tree order, so the list and the tree agree.
- Each file's header shows its `+/-` from GitHub's counts, also for patchless files.

## Errors

Each query has its own state: a part whose query fails shows `GitHubErrorState` in its place (the header's checks line shows a small "Checks unavailable" with Retry), and the rest of the panel keeps working. A 404 on checks or statuses (some repositories hide them) counts as no checks.

## Testing

Logic ported from T3 gets T3's own test cases where T3 has them (`pullRequestDetail.logic.test.ts` cases for conversations, timeline, checks grouping, review outcomes, base freshness; `pullRequestFileOrder.logic.test.ts`; `changedFileKind` cases); new logic (REST mapping, thread building, check run and status mapping, viewed hash) gets tests of its own. Components get render tests with `renderPluginComponent` and stubbed `fetch`, as today. Screenshots at the head: the header with checks and badges, the checks popover, the Summary tab with reviewers and comments, the Timeline tab, the Code tab with an inline thread and the commit selector, on public pull requests that have each of those.

## Delivery

A pull request in `mindroom-ai/pull-request-client-plugin` from `read-only-detail`, stacked on pull request #1 (based on `initial-plugin`), retargeted to `main` once #1 merges. No change to mindroom-chat.
