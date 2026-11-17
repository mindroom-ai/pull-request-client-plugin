# Pull request actions in the side panel: design

## Understanding

Bas (2026-11-16): "make the PR sidebar more interactive by also allowing to click on things like merge and such in the same way that T3 code has." Today the plugin's side panel (`src/PullRequestPanel.tsx`) is read-only: its header ends in "Open on GitHub" and "Forget token". Every write (merge, ready for review, close) means a trip to GitHub or asking an agent to run `gh`.

What T3 Code does (latest main, `428d365932`; full inventory with file:line in the design thread's `/tmp/pr-design/t3-actions.md`):

- **One primary control in the panel header**, chosen by `resolvePullRequestPrimaryControl` (`apps/web/src/components/pullRequest/pullRequestDetail.logic.ts:94-120`), first match wins: merged badge, closed badge, `resolve` (conflicting), `ready` (draft and allowed), `auto-merge-armed` badge, `enable-auto-merge` (checks not passing yet), `merge`. The merge button's label is the method ("Squash and merge").
- **An overflow menu** (`PullRequestActionsMenu.tsx`): merge method radio group (only when more than one is allowed), Merge now (while auto-merge is pending or armed), Enable / Disable auto-merge, Ready for review / Convert to draft, Close / Reopen, Delete branch (merged or closed), Revert, Refresh.
- **Update branch** lives in the base-branch warning popover ("Update branch", "Update with rebase"), shown when the branch is behind and mergeable (`PullRequestBaseBranch.tsx:64-79`).
- **Confirmation:** merge, auto-merge, close and revert use a two-click inline confirm: the first click turns the button into "Confirm merge?", a second click within 3 s runs it; Escape, blur or a click elsewhere disarms (`useInlineActionConfirm.ts`). Delete branch uses a confirm dialog. Ready, draft, reopen and disable auto-merge run at once.
- **Default merge method:** the first allowed of the per-PR choice, the project default, the last method chosen (persisted), else the first allowed (`resolvePullRequestMergeMethod`, `:72-80`).
- **Fix and Resolve hand off to the agent:** they never call GitHub. They put a prompt ("Fix the actionable findings on PR #N ...", "PR #N conflicts with its base branch ...", with the PR data marked as untrusted) into the thread's composer, and the user sends it (`ThreadDetailsPrRow.tsx:200-245`, `buildFixFindingsHandoff`, `buildResolveConflictsPrompt`).
- **Writing:** a Comment / Review composer (Comment, Approve, Request changes, with line comments), Reply and Resolve on review conversations, reaction toggles, title, description, labels and reviewers.

## What Bas said vs. assumptions

Said: actions like merge, clicked in the side panel, the way T3 does it.

Assumed (correct me):

1. The surface is the **side panel** (`PullRequestPanel`), not the thread strip or the Compact card chip. Card badges cannot hold controls (they sit inside the card's `<button>`), and the strip's chips are buttons too.
2. **Actions run in the browser with the token the plugin already stores**, as the plugin's reads do. The token then needs write access: fine-grained "Pull requests: Read and write" and "Contents: Read and write" (merge, update and delete branch), or classic `repo`. GitHub decides; the plugin shows its refusal with a hint about the token.
3. "Merge and such" means the PR's state actions first. Writing comments and reviews is a second step.

## Approaches

1. **Browser calls GitHub with the stored token (recommended).** Same path as every read today, no server, sub-second merges, works for any repository the token reaches. Cost: a write-capable token sits in browser storage that page scripts can read (the token note already says so). Bas picks the token's scope, so a read-only token keeps the panel read-only.
2. **Every action goes to the thread's agent** ("merge #N" as a message). No token in the browser, but every click costs an agent turn (seconds to a minute, and money), and fails in a room without an agent.
3. **A MindRoom backend endpoint** that runs `gh` with server credentials (T3's shape). Strongest credential story, but needs new backend API, auth per user and a host-to-repo mapping. Too much for this.

Pick 1 for state actions, and 2's idea only where T3 also hands off to the agent: Fix checks and Resolve conflicts (phase 3).

## Scope

In, phase 1 (plugin only, no SDK change):

- Header primary control, ported from `resolvePullRequestPrimaryControl`: Merge (method label), Auto-merge (method), Ready for review, and the badges Merged, Closed, Auto-merge armed. Conflicting shows a "Conflicts" badge until phase 3 gives it a Resolve button.
- Overflow menu (`⋯` IconButton beside the primary): merge method radio, Merge now, Enable / Disable auto-merge, Ready for review / Convert to draft, Close / Reopen, Delete branch, Refresh.
- Update branch (merge) in the existing `BaseBranch` freshness popover; Update with rebase too.
- Two-click inline confirm ported from `useInlineActionConfirm`, for merge, auto-merge, merge now and close. Delete branch confirms in the SDK `Dialog`.
- Inline result line under the header (the SDK has no toasts): pending ("Merging..."), failure with T3's hint texts, success only where nothing else changes on screen (Branch updated, Branch deleted).

In, phase 2 (plugin only): Comment and Review (Comment, Approve, Request changes) from a composer at the panel's bottom; Reply and Resolve / Unresolve on review conversations; reaction toggles.

In, phase 3 (app PR first, SDK version bump): Fix checks and Resolve conflicts put T3's handoff prompt into the shown thread's composer. Needs a new SDK call to append text to a thread's draft (`room`'s composer draft); plugins cannot reach the composer today.

Out: revert, approve workflows, stacks, maintainer edits, title and description editing, labels and reviewer pickers, line comments in the Code tab, batch actions, GitLab and other hosts. Each can follow if Bas misses it.

## Behavior (phase 1)

### Data

- `PullRequest` gains `nodeId` (`node_id`, for GraphQL) and `mergeable` (`mergeable`, true/false/null). `mergeableState` is already there (`dirty` means conflicting).
- New `fetchRepository(owner, repo)`: one GraphQL query, `repository(owner, name) { viewerPermission mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed autoMergeAllowed defaultBranchRef { name } }`, as T3 reads it (the REST repository's `allow_*` flags are not served to every reader). GraphQL always needs a token, which fits: the query runs only with one (no anonymous requests), `staleTime` 10 minutes, one key per repository, `retryOnMount: false` (no `refetchOnMount: false`: a panel opened after the token changed must ask again). Without a token, or when `viewerPermission` is not `ADMIN`, `MAINTAIN` or `WRITE`, the header shows no write controls at all (today's header).
- Allowed methods: the three `*Allowed` flags, in T3's order merge, squash, rebase.

### Writes

One `sendJson(method, path, body, token)` beside `getJson` in `github.ts` (same error mapping, plus 405/409/422 as `refused` with GitHub's `message`), and one `graphql(query, variables, token)`.

| Action | Call |
|---|---|
| Merge | REST `PUT /repos/{o}/{r}/pulls/{n}/merge` `{merge_method, sha: headSha}`; the `sha` makes GitHub refuse if the branch moved since the panel loaded |
| Ready for review / Convert to draft | GraphQL `markPullRequestReadyForReview` / `convertPullRequestToDraft` on `nodeId` |
| Enable / Disable auto-merge | GraphQL `enablePullRequestAutoMerge` (`mergeMethod`, `expectedHeadOid`) / `disablePullRequestAutoMerge` |
| Close / Reopen | REST `PATCH /repos/{o}/{r}/pulls/{n}` `{state}` |
| Update branch | GraphQL `updatePullRequestBranch` with `expectedHeadOid` and `updateMethod: MERGE` or `REBASE`, one path for both as T3 (REST `PUT .../update-branch` only answers 202 Accepted). GitHub makes the new commit after it answers, so the action stays pending while the pull request is read at once and then every 2 s, up to 30 s, until its `headSha` changes; then "Branch updated" and the refetch. On a timeout the line says "Branch update requested" |
| Delete branch | GraphQL, as T3: read `node(id: headRepoId) { ... on Repository { ref(qualifiedName: "refs/heads/{headRef}") { target { oid } } } }` (gone: done; another commit than `headSha`: refused here), then `updateRefs(input: {repositoryId: headRepoId, refUpdates: [{name, beforeOid: headSha, afterOid: 40 zeros}]})`, so GitHub deletes the branch only where the pull request left it. Never REST's unconditional `DELETE .../git/refs/heads/{headRef}`. Offered only when merged or closed, the head repo is the base repo, the head ref is not the default branch, and the same read (a query under the pull request's key) says the branch still points at `headSha` |

After any success: invalidate the PR's query prefix (`['pull-requests', owner, repo, number]`), so the header, checks and timeline refetch. One action runs per PR at a time (a pending set keyed by the PR, as T3's runner); every control is disabled while one is pending.

### Merge method

`resolveMergeMethod(allowed, chosen, lastChosen)`: the PR's choice in the menu, then the last method chosen (plugin storage key `mergeMethod`, per account), then the first allowed. MindRoom has no project settings, so T3's project default step drops out. A pull request with auto-merge armed starts with the armed method as its choice (T3 `PullRequestDetailPanel.tsx:568-573`), so Merge now merges as the badge says; it is not stored as the last method chosen.

### Primary control

`primaryControl(pr, repo, checks)` is a pure function with unit tests, ported from T3 with our names:

1. merged, closed: badge
2. `mergeableState === 'dirty'`: Conflicts badge (phase 3: Resolve)
3. draft: Ready for review (with push), else nothing
4. auto-merge armed: badge "Auto-merge (squash)"
5. no allowed method: nothing
6. checks pending or failing (not none), `autoMergeAllowed`, and GitHub would not merge now (`mergeableState` is not `clean`, `has_hooks` or `unstable`): Auto-merge (method). GitHub refuses `enablePullRequestAutoMerge` on a pull request it can merge at once, so in those three states the control is Merge and the menu lists no Enable auto-merge (T3's `IMMEDIATELY_MERGEABLE` and `canMergeNow`).
7. Merge (method)

`blocked` and `behind` still merge: GitHub refuses with its own reason (required reviews, branch protection), and the result line shows it.

### Phone

The panel covers the conversation on a phone; the header controls are the same, at touch size. The two-click confirm works with taps.

## Error handling

- 401: the token is refused (existing `badToken` state).
- 403 or 404 on a write: "GitHub refused it. The saved token may not have write access to this repository (Pull requests and Contents: Read and write)."
- 405, 409, 422: GitHub's `message` ("Pull Request is not mergeable", "Head branch was modified"), then a refetch, so the header shows the new state.
- Network failure: "Could not reach GitHub." The control re-enables; nothing is retried on its own.

## Testing

- Unit: `primaryControl` for every branch; `resolveMergeMethod`; the inline confirm (arm, confirm, Escape, outside click, timeout, a different action); each write's request (method, path, body, `sha`) against a mocked `fetch`; the error mapping; the pending lock; that a panel without a token or without push sends no `GET /repos` and shows no control.
- e2e (plugin Playwright project, mocked GitHub): merge with confirm, method change remembered, close then reopen, update branch from the popover. Screenshots of the header in each primary state for the PR body, wide panel and phone.

## Delivery

- PR 1, plugin: upstream fixes from T3 (separate, see the audit), independent of this.
- PR 2, plugin: phase 1. No `apiVersion` bump.
- PR 3, plugin: phase 2.
- PR 4, app: composer draft SDK call (`CLIENT_PLUGIN_API_VERSION` + 1); PR 5, plugin: Fix checks and Resolve conflicts on it.
- The link-click work in another thread (`mindroom-chat-link-panel-click`, the message link card and panel opening) touches `PullRequestCard.tsx` and the SDK's message links, not the panel header; whichever merges second rebases.

## Appendix: T3 fixes since our port

The plugin was ported at T3 `8ab427c6` (2026-11-09) and `943de8fe`; 38 T3 commits touched those files since. Audit: 7 bugs present in ours, 8 features, 9 already fine here, 14 not applicable (other hosts, T3's server). Port first:

1. `1f698f01d9`: diff folds follow the current Viewed state; ours reads the marks only when the Code tab opens (`CodeTab.tsx:291-309`), so a file that shows Changed after a push stays folded.
2. `aace48bfe4`: file order follows imports of dotted modules, `.mts`/`.cts` and `?worker` imports (`fileOrder.logic.ts`).
3. `1c86881dd5`: Expand all in the file tree no longer rescans every folder per expansion (`DiffFileTree.tsx:157`, quadratic).
4. `3a30b011c3`: cancelled checks show a gray stop sign, not the red failure X (`presentation.tsx:185`).
5. `348009de22`: `*.stories.*` files count as tests (`changedFileKind.ts`).
6. `6dd092315e`, `3ee426272b`: tree icons follow the theme's muted color; the Viewed checkbox's click area covers its row height.
7. `@pierre/diffs` 1.6.4 to 1.7.0-beta.4: folded files are no longer fully highlighted on the main thread, and find comes with it (own PR, beta).
8. `b3fdf2b10f` with `e9d5bae5cf`: a pasted link to a review comment, commit, checks or diff line opens the panel on that item (`github.ts:72-82` drops everything after the number today). A feature; its own PR.
