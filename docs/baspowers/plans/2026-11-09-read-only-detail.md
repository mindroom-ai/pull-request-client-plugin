# Read-only Pull Request View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: implement this plan task-by-task with the skill named in **Execution**. Steps use checkbox (`- [ ]`) syntax.

**Execution:** baspowers:subagent-driven-development (eight tasks that build on one data layer; a fresh reviewer per task keeps the ported logic honest against T3 Code).

**Goal:** The plugin's side panel shows everything T3 Code's pull request panel shows that only reads: checks, reviewers and verdicts, labels, merge and base state, conversation, Timeline, inline review threads, a commit selector and the Code tab's display controls.

**Architecture:** `src/github.ts` grows REST fetchers and types for checks, comparison, reviews, comments, review comments, commits and one commit's files; `src/queries.ts` wraps each in a lazily enabled query. `src/detail/detail.logic.ts` ports T3's pure logic (conversations, timeline, checks grouping, review outcomes, base freshness) onto those types. Components in `src/detail/` port T3's header parts, popover, Summary and Timeline tabs; `src/CodeTab.tsx` gains annotations, a commit selector, viewed marks and toolbar controls.

**Tech Stack:** as the plugin today: React 18.2 (the app's), TanStack Query (the app's client), folds and the client SDK, `@pierre/diffs` (line annotations), `@pierre/trees`, `lucide-react`; Vitest through the app with `MINDROOM_CLIENT_PLUGINS`.

**Spec:** `docs/baspowers/specs/2026-11-09-read-only-detail-design.md` (in this repository).

## Global Constraints

- Plugin repository `/home/basnijholt/Work/dev/pull-request-client-plugin`, branch `read-only-detail` (stacked on `initial-plugin`). Commits `git -c commit.gpgsign=false commit`, files by path, no em dashes. Never push.
- Tests: `cd /home/basnijholt/.t3/worktrees/mindroom-client/t3-6eb327c4 && MINDROOM_CLIENT_PLUGINS=/home/basnijholt/Work/dev/pull-request-client-plugin nix develop -c npx vitest run /home/basnijholt/Work/dev/pull-request-client-plugin/src` (always the `/src` filter); `npm run typecheck` in the plugin (0 errors). Plugin tests cannot import `@testing-library/react`: use `renderPluginComponent`'s queries, `act` from `react-dom/test-utils`, `IS_REACT_ACT_ENVIRONMENT`, a fresh `QueryClientProvider`, stubbed `fetch` (see `src/PullRequestCard.test.tsx`).
- Requests go to `https://api.github.com` only, with the headers `github.ts` already sends; the token only when stored, never in a key, log, error or panel request. Nothing writes to GitHub: only `GET`.
- Every new query: `staleTime: 120_000` (the existing two move to it too), enabled only when the part that shows it renders, keyed under `['pull-requests', ...]` with `tokenSet` as today.
- Lists page with `per_page=100` and stop at 10 pages; a cut list carries `truncated: true`, shown as "Showing the first N; see the rest on GitHub" with a link.
- `@pierre/*` only in modules the lazy panel loads; nothing `src/index.tsx` imports eagerly may import it.
- Ported files start with `// Ported from T3 Code (https://github.com/pingdotgg/t3code, <path> at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.`; ported logic brings T3's test cases that still apply. T3 sources: `/tmp/t3code-src/repo` (`apps/web/src/components/pullRequest/`, `packages/shared/src/changedFileKind.ts`, `apps/web/src/lib/diffRendering.ts`).
- Styles: `mrpr-` classes on the `--pr-*` variables (`src/theme.ts`), logical sides; strings in `src/strings.ts`, translated with `usePluginTranslation('pull-requests')`; local UI state in `usePluginStorage('pull-requests')`.

## Review Focus

- A repository whose check endpoints answer 404, or a head with no checks: the checks line says "No checks" and nothing errors (Task 1 test `checks 404 is no checks`; Task 3 test `no checks`).
- Review comments on lines outside every rendered hunk, outdated ones (`position` null), and every thread while a single commit is shown: all land in "Conversations not on the current diff", none vanish (Task 7 tests).
- A commit chosen in the selector disappears after a force push: the view falls back to All commits (Task 7 test `falls back when the commit is gone`).
- A fork's pull request: the head branch shows `owner:branch`, and the comparison uses the head SHA, not the branch name (Task 1 test `compares by head sha`; Task 4 test `fork head`).
- The anonymous rate limit runs out while the panel loads: each part shows its own error state with Retry, and parts already loaded stay (Task 4 test `a failing checks query leaves the header`).

---

### Task 1: REST data layer

**Files:**
- Modify: `src/github.ts`, `src/github.test.ts`, `src/queries.ts`
- Create: `src/reviewThreads.ts`, `src/reviewThreads.test.ts`

**Interfaces (produces, all exported from `src/github.ts` unless named):**
- `type Actor = { login: string; name: string | null; avatarUrl: string | null; url: string | null; isBot: boolean }` (`isBot`: `user.type === 'Bot'` or a login ending `[bot]`); `PullRequest.author` becomes `Actor | null`.
- `PullRequest` gains `labels: { name: string; color: string }[]`, `requestedReviewers: Actor[]`, `requestedTeams: string[]`, `mergeableState: string | null`, `autoMerge: { method: 'merge' | 'squash' | 'rebase' } | null`, `headSha: string`, `headRepo: string | null` (`head.repo.full_name`), `baseRepo: string`, `mergedAt: string | null`, `closedAt: string | null`, `commentCount: number`, `reviewCommentCount: number`, `commitCount: number`.
- `type Paged<T> = { items: T[]; truncated: boolean }`; an internal `fetchPaged` used by every list (10 pages of 100 at most).
- `type CheckStatus = 'pending' | 'action-required' | 'success' | 'failure' | 'cancelled' | 'skipped' | 'neutral'`; `type PullRequestCheck = { name: string; status: CheckStatus; description: string | null; url: string | null; updatedAt: string | null }`; `fetchChecks(ref, headSha, token, signal?): Promise<PullRequestCheck[]>`: check runs and commit statuses mapped as the spec's "Checks popover" section says, the newer of a run and a status with the same name kept; a 404 on either endpoint counts as none from it.
- `fetchBehindBy(ref, baseRef, headSha, token, signal?): Promise<number>`: `compare/{baseRef}...{headSha}` `behind_by`.
- `type ReviewState = 'APPROVED' | 'CHANGES_REQUESTED' | 'COMMENTED' | 'DISMISSED'`; `type Review = { id: number; state: ReviewState; author: Actor | null; body: string; commitId: string; submittedAt: string; url: string }` (`PENDING` reviews dropped); `fetchReviews(ref, token, signal?): Promise<Paged<Review>>`.
- `type ReactionContent = '+1' | '-1' | 'laugh' | 'hooray' | 'confused' | 'heart' | 'rocket' | 'eyes'`; `type Reaction = { content: ReactionContent; count: number }` (zero counts dropped, in that order).
- `type Comment = { id: number; author: Actor | null; body: string; createdAt: string; url: string; reactions: Reaction[] }`; `fetchConversationComments(ref, token, signal?): Promise<Paged<Comment>>` (issue comments).
- `type ReviewComment = Comment & { path: string; line: number | null; originalLine: number | null; side: 'LEFT' | 'RIGHT'; inReplyToId: number | null; reviewId: number | null; outdated: boolean; commitId: string }` (`outdated`: `position === null`); `fetchReviewComments(ref, token, signal?): Promise<Paged<ReviewComment>>`.
- `type Commit = { sha: string; headline: string; author: Actor | null; authorName: string; committedAt: string; url: string }`; `fetchCommits(ref, token, signal?): Promise<Paged<Commit>>`.
- `fetchCommitFiles(ref, sha, token, signal?): Promise<PullRequestFile[]>` (`GET /repos/{o}/{r}/commits/{sha}`'s `files`, mapped as the pull request's).
- In `src/reviewThreads.ts`: `type ReviewThread = { id: number; path: string; line: number | null; side: 'LEFT' | 'RIGHT'; outdated: boolean; comments: ReviewComment[] }`; `buildReviewThreads(comments: ReviewComment[]): ReviewThread[]` (a root and its replies by `inReplyToId`, replies by `createdAt`; a reply whose root is missing becomes its own thread; threads by their root's `createdAt`).
- In `src/queries.ts`: `useChecks(ref, headSha, enabled)`, `useBehindBy(ref, baseRef, headSha, enabled)`, `useReviews(ref, enabled)`, `useConversationComments(ref, enabled)`, `useReviewComments(ref, enabled)`, `useCommits(ref, enabled)`, `useCommitFiles(ref, sha, enabled)`; `staleTime: 120_000` for all, the two existing ones included.

- [ ] **Step 1: Write the failing tests** (stubbed `fetch`): `maps the new pull request fields` (labels, requested reviewers and teams, `mergeable_state`, `auto_merge.merge_method`, head sha and repo, counts); `marks bots` (`type: 'Bot'`, `dependabot[bot]`); `maps check runs` (a table: queued/in_progress/waiting/requested/pending to pending, action_required, success, failure, timed_out and startup_failure to failure, cancelled, skipped, neutral and stale to neutral); `maps commit statuses` (pending, success, failure and error to failure); `keeps the newer of a run and a status with one name`; `checks 404 is no checks`; `compares by head sha` (URL ends `compare/main...<sha>`, returns `behind_by`); `drops pending reviews`; `maps reactions in order without zeros`; `marks outdated review comments`; `pages lists and stops at ten pages with truncated` (11 full pages stubbed: 10 requests, `truncated: true`); `maps one commit's files`; in `reviewThreads.test.ts`: `groups replies under their root in time order`, `an orphan reply is its own thread`, `orders threads by their root`.
- [ ] **Step 2: Run** the plugin tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Update every existing use of `PullRequest.author` (card, panel, presentation) to the new `Actor` without changing what they show.
- [ ] **Step 4: Run** the plugin tests and `npm run typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `GitHub data for the read-only view: checks, comparison, reviews, comments, commits`.

### Task 2: Ported logic

**Files:**
- Create: `src/detail/detail.logic.ts`, `src/detail/detail.logic.test.ts` (ported from `pullRequestDetail.logic.ts` and its test, onto Task 1's types)
- Create: `src/diff/changedFileKind.ts`, `src/diff/changedFileKind.test.ts` (port of `packages/shared/src/changedFileKind.ts`)
- Create: `src/diff/fileOrder.logic.ts`, `src/diff/fileOrder.logic.test.ts` (port of `pullRequestFileOrder.logic.ts` and its test)
- Modify: `src/diff/diffRendering.ts` (port `hideWhitespaceChanges`; `getRenderablePatch` takes `{ ignoreWhitespace?: boolean }`), add its test

**Interfaces (produces, `src/detail/detail.logic.ts`):**
- `type ReviewOutcome = { login: string; actor: Actor | null; verdict: 'approved' | 'changes-requested'; stale: boolean; review: Review }`; `latestReviewOutcomes(reviews: Review[], headSha: string): ReviewOutcome[]` (each author's latest APPROVED or CHANGES_REQUESTED review, unless a later DISMISSED one of theirs; `stale` when its `commitId` is not `headSha`).
- `type ChecksState = 'none' | 'passing' | 'failing' | 'pending'`; `checksState(checks): ChecksState`; `summarizeChecks(checks): string` (T3's texts: "All checks have passed", "<f> of <n> failing", "<r> of <n> running"); `groupChecks(checks): { attention: PullRequestCheck[]; running: PullRequestCheck[]; completed: PullRequestCheck[] }`.
- `type ConversationItem = { kind: 'comment'; comment: Comment } | { kind: 'review'; review: Review } | { kind: 'thread'; thread: ReviewThread }`; `conversationItems(comments: Comment[], reviews: Review[], threads: ReviewThread[], order: 'newest' | 'oldest'): ConversationItem[]` (reviews only with a body; chronological by first timestamp).
- `type TimelineEvent = { kind: 'opened' | 'merged' | 'closed'; at: string; actor: Actor | null } | { kind: 'commit'; at: string; commit: Commit } | { kind: 'verdict'; at: string; review: Review } | { kind: 'thread'; at: string; thread: ReviewThread } | { kind: 'conversation'; at: string; items: ConversationItem[] }`; `buildTimeline(input: { pullRequest: PullRequest; commits: Commit[]; reviews: Review[]; comments: Comment[]; threads: ReviewThread[] }, order: 'newest' | 'oldest'): TimelineEvent[]` (runs of plain comments and bodied COMMENTED reviews grouped into one `conversation` event, as T3's `groupPullRequestTimelineConversations`; merged wins over closed).
- `baseFreshness(behindBy: number | undefined, mergeableState: string | null): { behind: number; conflicts: boolean } | undefined` (undefined when neither applies).
- `src/diff/changedFileKind.ts`: `changedFileKind(path: string): 'code' | 'test' | 'generated' | 'docs'` and `isTestFile(path): boolean`, from T3's rules.
- `src/diff/fileOrder.logic.ts`: `orderDiffFiles(files: FileDiffMetadata[]): FileDiffMetadata[]`, T3's order.

- [ ] **Step 1: Port the T3 test cases** that apply to each function (adapted to Task 1's types), plus: `latestReviewOutcomes marks a review of an older commit stale`, `a later dismissal removes the verdict`, `conversationItems leaves out reviews without a body`, `buildTimeline groups adjacent plain comments and keeps verdicts apart`, `merged wins over closed`, `baseFreshness with conflicts and no lag`, `ignore whitespace hides an indentation-only change`. Run. Expected: FAIL.
- [ ] **Step 2: Port** the logic. Run the plugin tests and typecheck. Expected: PASS.
- [ ] **Step 3: Commit** `Conversation, timeline, checks, reviews and file order logic, ported from T3 Code`.

### Task 3: Presentation pieces and the checks popover

**Files:**
- Modify: `src/presentation.tsx` (port `PullRequestCheckStatusIcon` and the check status table, `pullRequestChecksStatePresentation`, review outcome ring, badge and icon, `PullRequestLabelChip`, `PullRequestActorLabel` with the profile link and "name (@login)" tooltip), `src/presentation.test.tsx`
- Create: `src/detail/Reactions.tsx` (port of `PullRequestReactions.tsx`'s pills, counts only), `src/detail/CommentBody.tsx` (port of `PullRequestCommentBody.tsx`: Markdown through `useMarkdownHtml`, clamped at 240 px with "Show full comment"), `src/detail/ChecksPopover.tsx` (port), `src/detail/ChecksStatusLine.tsx` (`ChecksStatusLine({ pullRequest, pullRequestRef })` loading `useChecks` and opening the popover), tests for each

**Interfaces:**
- `ChecksPopover({ checks }: { checks: PullRequestCheck[] })` content; `ChecksStatusLine` shows "No checks" for none, "Checks unavailable" with Retry on error.
- Popover anchored with the SDK's `PopOut` from `@mindroom/client-sdk/ui`, closed by Escape and outside click (the example plugin's FocusTrap pattern).

- [ ] **Step 1: Write the failing tests**: check status labels and icons for each `CheckStatus`; `summarizes failing and running`; `no checks`; the popover lists attention first, hides completed behind "Show all" when others exist, shows all completed when nothing else; label chip text and color; actor label link and tooltip text; reactions render counts in order and nothing for none; comment body clamps and "Show full comment" expands. Run. Expected: FAIL.
- [ ] **Step 2: Implement.** Run tests and typecheck. Expected: PASS.
- [ ] **Step 3: Commit** `Checks popover, review verdicts, labels, reactions and comment bodies, ported from T3 Code`.

### Task 4: Header and tab bar

**Files:**
- Modify: `src/PullRequestPanel.tsx`, `src/PullRequestPanel.test.tsx`, `src/styles.css`, `src/strings.ts`
- Create: `src/detail/BaseBranch.tsx` (port of `PullRequestBaseBranch.tsx`'s display), `src/detail/ChangeBreakdownStat.tsx` (port; counts from `changedFileKind` over the files' additions and deletions; loads `usePullRequestFiles` on first hover)

**Interfaces:** the header as the spec's "Header" section; tabs `summary | timeline | code`; the tab bar's end: `ChecksStatusLine` on Summary; on Timeline the comment count (`commentCount + reviewCommentCount`), commit count, approvals count (fresh `approved` outcomes) and the Newest/Oldest toggle, whose value Task 6 reads (lift it into the panel's state and pass it down).

- [ ] **Step 1: Write the failing tests**: `links the repository and number`; `opens the author's profile`; `copies the checkout command` (`gh pr checkout 195 -R mindroom-ai/mindroom-chat` via a stubbed `navigator.clipboard.writeText`); `fork head` (`octo:feature` when `headRepo` differs from `baseRepo`); `shows behind and conflicts` (popover text from `behind_by` 3 and `mergeable_state: 'dirty'`); `badges for draft, merged, closed and auto-merge`; `breakdown tooltip splits code and tests`; `Timeline shows counts and the order toggle`; `a failing checks query leaves the header` (checks 403 rate limited: the line says "Checks unavailable", the title still shows). Run. Expected: FAIL.
- [ ] **Step 2: Implement.** Run tests and typecheck. Expected: PASS.
- [ ] **Step 3: Commit** `Pull request header: links, checkout command, base state, badges, breakdown and checks line`.

### Task 5: Summary tab

**Files:**
- Create: `src/detail/SummaryTab.tsx` (port of `PullRequestSummaryTab.tsx`'s display), `src/detail/SummaryTab.test.tsx`; wire it into `src/PullRequestPanel.tsx` in place of today's Summary

**Interfaces:** sections as the spec's "Summary tab"; the comment filter "Show bots" kept in plugin storage under `summary:showBots` (default off; the trigger shows "<N> hidden" when bots are hidden); order `newest` by default; 10 conversations at a time with "Show <N> older conversations".

- [ ] **Step 1: Write the failing tests**: `reviewers show their latest verdicts and stale approvals faded` (ring class and the "Approved earlier changes" label); `requested reviewers and teams without a review show plain`; `labels`; `description collapses`; `checks section lists checks collapsed by default`; `comments in order with paging`; `hides bot comments until Show bots`; `a thread card shows path, line and Outdated`; `truncated lists say so with a GitHub link`; `a failing reviews query shows its error state and the comments still render`. Run. Expected: FAIL.
- [ ] **Step 2: Implement.** Run tests and typecheck. Expected: PASS.
- [ ] **Step 3: Commit** `Summary tab: reviewers, labels, description, checks and comments, ported from T3 Code`.

### Task 6: Timeline tab

**Files:**
- Create: `src/detail/TimelineTab.tsx` (port of `PullRequestTimelineTab.tsx` without its virtualization), `src/detail/TimelineTab.test.tsx`; wire it into `src/PullRequestPanel.tsx`

**Interfaces:** `TimelineTab({ pullRequestRef, pullRequest, order, onOpenCommit })` (not `ref`, which React reserves); `onOpenCommit(sha)` switches the panel to Code with that commit selected (Task 7 reads it; keep the selected commit in the panel's state).

- [ ] **Step 1: Write the failing tests**: `lists opened, commits, verdicts, threads and merged newest first`; `oldest first reverses`; `groups plain comments and expands the group`; `choosing a commit opens Code on it` (`onOpenCommit` with the SHA); `No activity yet.`. Run. Expected: FAIL.
- [ ] **Step 2: Implement.** Run tests and typecheck. Expected: PASS.
- [ ] **Step 3: Commit** `Timeline tab, ported from T3 Code`.

### Task 7: Code tab: inline threads and the commit selector

**Files:**
- Modify: `src/CodeTab.tsx`, `src/CodeTab.test.tsx`, `src/diff/StyledDiffCodeView.tsx` (pass `annotations` and `renderAnnotation`)
- Create: `src/detail/ReviewThreadCard.tsx` (port of `ReviewThreadCard`'s display part), `src/detail/OffDiffThreads.tsx`, `src/detail/CommitSelector.tsx`, `src/diff/threadAnnotations.ts` (port of `isLineInFileDiff` and the grouping by `side:line` into `DiffLineAnnotation`s), with tests

**Interfaces:** `CodeTab({ pullRequest, files, threads, commits, commit, onCommitChange })`; with `commit` set it renders `useCommitFiles` for that SHA and puts every thread in the off-diff bar; `onCommitChange(undefined)` is All commits.

- [ ] **Step 1: Write the failing tests**: `threads on rendered lines become annotations` (side LEFT to deletions, RIGHT to additions; the mocked `CodeView` receives them); `threads outside the hunks, outdated threads and all threads on a commit view go to the bar`; `the bar groups by path and collapses`; `the thread card shows comments and Outdated`; `the selector lists commits newest first ten at a time`; `choosing a commit shows its files`; `falls back when the commit is gone` (a selected SHA missing from `commits`: All commits). Run. Expected: FAIL.
- [ ] **Step 2: Implement.** Confirm against `@pierre/diffs`' `.d.ts` how `CodeViewDiffItem` takes annotations and `renderAnnotation`. Run tests and typecheck. Expected: PASS.
- [ ] **Step 3: Commit** `Code tab: review threads in the diffs and a commit selector, ported from T3 Code`.

### Task 8: Code tab: viewed marks, display controls and file order

**Files:**
- Modify: `src/CodeTab.tsx`, `src/CodeTab.test.tsx`, `src/diff/StyledDiffCodeView.tsx`
- Create: `src/diff/viewedFiles.ts` (`useViewedFiles(ref): { stateOf(path, patch): 'unviewed' | 'viewed' | 'changed'; toggle(path, patch): void; markRange(paths, patches, viewed): void; viewedCount }`, stored under `viewed:<owner>/<repo>#<number>` as `{ [path]: fnv1a32(patch) }`), `src/diff/codePrefs.ts` (`useCodePrefs()`: `{ hideTests, ignoreWhitespace, diffStyle: 'unified' | 'split', wrap }` under `code:prefs`), with tests

**Interfaces:** the toolbar as the spec's "Display controls"; collapse or expand all is per view (not stored); files ordered by `orderDiffFiles` then tree order; each header shows GitHub's `+/-` (`PullRequestFile.additions`/`deletions`).

- [ ] **Step 1: Write the failing tests**: `marks a file viewed and collapses it`; `a changed patch shows Changed`; `Shift-click marks a range`; `X / N viewed`; `hide test files hides them and says how many`; `ignore whitespace re-parses`; `split and wrap reach the diff view`; `prefs persist across mounts`; `orders source before its tests and lockfiles last`. Run. Expected: FAIL.
- [ ] **Step 2: Implement.** Run tests and typecheck. Expected: PASS.
- [ ] **Step 3: Commit** `Code tab: viewed marks, display controls and T3's file order`.

### Task 9: Build, screenshots, pull request (controller)

- [ ] Build the app with the plugin (exit 0, no `pierre` in the entry chunk); `just license-check` with the plugin.
- [ ] Throwaway Playwright spec (uncommitted) on a slot: the header with checks and badges, the checks popover, Summary with reviewers and comments, Timeline, Code with an inline thread, the commit selector, and the toolbar; on public pull requests that have each (find them with `gh api`). Read every shot and fix what looks wrong.
- [ ] Remove `docs/baspowers/` from the branch, push `read-only-detail`, open the pull request against `initial-plugin` with the screenshots.
