# Pull request actions, phase 1: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: implement this plan task-by-task with the skill named in **Execution**. Steps use checkbox (`- [ ]`) syntax.

**Execution:** baspowers:subagent-driven-development: six tasks with shared interfaces that write to GitHub for real, so each gets its own implementer and a fresh review.

**Goal:** The side panel's header gets T3 Code's primary action and `⋯` menu (merge, auto-merge, ready, draft, close, reopen, delete branch, refresh), and the branch-behind popover gets Update branch, all run in the browser with the stored GitHub token.

**Architecture:** `src/github.ts` gains two write primitives (REST and GraphQL) and one function per action. Pure decisions (which primary control, which merge method, whether to offer Delete branch) live in `src/actions/actions.logic.ts`. One hook, `usePullRequestActions`, loads the repository's permissions and merge settings, runs one action at a time per pull request, and invalidates the pull request's queries on success. `HeaderActions.tsx` draws the controls; `BaseBranch.tsx` gets the update buttons.

**Tech Stack:** React, TanStack Query (from the client), the client SDK (`@mindroom/client-sdk/core`, `ui`), lucide-react, vitest with jsdom.

**Spec:** `docs/baspowers/specs/2026-11-16-pr-actions-design.md`

## Global Constraints

- Plugin repo rules: tests beside their subject (`x.test.ts(x)`), no em dashes anywhere, Prettier clean, `tsc --noEmit` clean, comments in the repo's plain style. Every new UI string goes in `src/strings.ts` (`en`), used through `usePluginTranslation('pull-requests')`.
- No `apiVersion` bump, no app change: everything uses SDK version 62 exports.
- No request without a token: the repository query is `enabled` only when `useGitHubToken().token !== undefined`.
- No token value in a query key, an error message or a log.
- Writes go to `https://api.github.com` (REST, `X-GitHub-Api-Version: 2022-11-28`) and `https://api.github.com/graphql`, with `Authorization: Bearer <token>`.
- Merge sends the loaded `headSha` (REST `sha`); auto-merge and rebase update send `expectedHeadOid`; merge update sends `expected_head_sha`. GitHub then refuses if the branch moved.
- Gates (worktree `/home/basnijholt/repos/worktrees/pull-request-client-plugin-actions`, client host `/home/basnijholt/repos/worktrees/mindroom-chat-prcp-actions-host`):
  - tests, from the host: `MINDROOM_CLIENT_PLUGINS=<plugin dir> MINDROOM_CLIENT_PLUGIN_TESTS_ONLY=1 nix develop -c npx vitest run <plugin dir>/src --minWorkers=1 --maxWorkers=4`
  - types, from the plugin dir: `nix develop <host> -c ./.mindroom-chat/node_modules/.bin/tsc --noEmit`
  - format, from the plugin dir: `./.mindroom-chat/node_modules/.bin/prettier --check src e2e README.md package.json tsconfig.json`
- Commits end with the trailer `Assisted-by: MindRoom DevAgent:anthropic/claude-opus-5.5 <https://github.com/mindroom-ai/mindroom>` (implementers on another model use their own model id). Never `git stash`.

## Review Focus

1. A second click while an action runs (double-click on Merge, Merge then Close) must send exactly one request: test in Task 4.
2. A token without write access (403 "Resource not accessible by personal access token") must show the token hint, not a generic failure: test in Task 1 (mapping) and Task 5 (text).
3. GraphQL answers HTTP 200 with an `errors` array on refusal; that must be a failure with GitHub's message, not a success: test in Task 1.
4. The panel switching to another pull request while an action runs must not show the old result on the new one, nor unlock the new one's controls early: test in Task 4.
5. A repository the viewer can only read (or no token) must render today's header exactly, and send no GraphQL request without a token: test in Task 5.

---

### Task 1: GitHub writes

**Files:**
- Modify: `src/github.ts`
- Test: `src/github.test.ts`

**Interfaces:**
- Produces:
  - `PullRequest` gains `nodeId: string` (from `node_id`) and `mergeable: boolean | null` (from `mergeable`).
  - `type MergeMethod = 'merge' | 'squash' | 'rebase'`
  - `type Repository = { canWrite: boolean; mergeMethods: MergeMethod[]; autoMergeAllowed: boolean; defaultBranch: string }`; `mergeMethods` in the order merge, squash, rebase, only the allowed ones; `canWrite` is `viewerPermission` in `ADMIN`, `MAINTAIN`, `WRITE`.
  - `fetchRepository(owner: string, repo: string, token: string, signal?: AbortSignal): Promise<Repository>`
  - `class GitHubWriteError extends Error { kind: 'noAccess' | 'refused' | 'badToken' | 'failed'; status: number; detail: string | null }`: 401 is `badToken`; 403 and 404 are `noAccess`; 405, 409 and 422 are `refused` with GitHub's `message`; a GraphQL `errors` array is `refused` with `errors[0].message` (`noAccess` when its `type` is `FORBIDDEN` or `NOT_FOUND`); a network failure is `failed` with status 0. `detail` never holds the token.
  - `type PullRequestAction = 'merge' | 'enable-auto-merge' | 'disable-auto-merge' | 'ready' | 'draft' | 'close' | 'reopen' | 'update-branch' | 'update-branch-rebase' | 'delete-branch'`
  - `runPullRequestAction(ref: PullRequestRef, pr: PullRequest, action: PullRequestAction, method: MergeMethod, token: string): Promise<void>`

- [ ] **Step 1: Write the failing tests** in `src/github.test.ts`, stubbing `fetch` as the file already does. One test per row, asserting method, URL, JSON body and the `Authorization` header:

| action | request |
|---|---|
| merge (squash) | `PUT /repos/o/r/pulls/7/merge` `{ merge_method: 'squash', sha: <headSha> }` |
| close / reopen | `PATCH /repos/o/r/pulls/7` `{ state: 'closed' }` / `{ state: 'open' }` |
| update-branch | `PUT /repos/o/r/pulls/7/update-branch` `{ expected_head_sha: <headSha> }` |
| delete-branch | `DELETE /repos/<headRepo>/git/refs/heads/<headRef, each segment encodeURIComponent>` |
| ready / draft / disable-auto-merge | `POST /graphql`, query names `markPullRequestReadyForReview` / `convertPullRequestToDraft` / `disablePullRequestAutoMerge`, `variables: { pullRequestId: <nodeId> }` |
| enable-auto-merge | `POST /graphql` `enablePullRequestAutoMerge`, `variables: { pullRequestId, mergeMethod: 'SQUASH', expectedHeadOid: <headSha> }` |
| update-branch-rebase | `POST /graphql` `updatePullRequestBranch`, `variables: { pullRequestId, expectedHeadOid, updateMethod: 'REBASE' }` |

Plus: `fetchRepository` maps `{ data: { repository: { viewerPermission: 'WRITE', mergeCommitAllowed: false, squashMergeAllowed: true, rebaseMergeAllowed: true, autoMergeAllowed: true, defaultBranchRef: { name: 'main' } } } }` to `{ canWrite: true, mergeMethods: ['squash', 'rebase'], autoMergeAllowed: true, defaultBranch: 'main' }`, and `READ` to `canWrite: false`; the error mapping: 403 with body `{ message: 'Resource not accessible by personal access token' }` gives `kind: 'noAccess'`, 405 `{ message: 'Pull Request is not mergeable' }` gives `refused` with that `detail`, HTTP 200 `{ errors: [{ message: 'Head branch was modified' }] }` gives `refused` with that `detail`, a rejected fetch gives `failed`/0, and no error's `message` or `detail` contains the token string. `fetchPullRequest` maps `node_id` and `mergeable`.

- [ ] **Step 2: Run them, expect FAIL** (missing exports).
- [ ] **Step 3: Implement** `sendRest(method, path, body, token)` and `graphql(query, variables, token)` (private) beside `getJson`, the error class, `fetchRepository`, `runPullRequestAction` (one `switch` over the table), and the two new `PullRequest` fields. Writes do not touch the `rateLimits` map.
- [ ] **Step 4: Run, expect PASS**, then the type gate (fixtures building a `PullRequest` by hand need the two fields).
- [ ] **Step 5: Commit** `Actions: GitHub writes for a pull request's state, with GitHub's refusals as errors`

### Task 2: Decisions

**Files:**
- Create: `src/actions/actions.logic.ts`, `src/actions/actions.logic.test.ts`

**Interfaces:**
- Consumes: `PullRequest`, `Repository`, `MergeMethod` (Task 1); `ChecksState` from `src/detail/detail.logic.ts`.
- Produces:
  - `type PrimaryControl = 'merged' | 'closed' | 'conflicts' | 'ready' | 'auto-merge-armed' | 'enable-auto-merge' | 'merge' | null`
  - `primaryControl(pr: PullRequest, repo: Repository, checks: ChecksState | undefined): PrimaryControl`, in order: `pr.state === 'merged'` merged; `closed` closed; `mergeableState === 'dirty'` conflicts; draft: `ready` if `repo.canWrite` else null; `pr.autoMerge` armed; no `mergeMethods` null; `checks` `pending` or `failing` and `autoMergeAllowed`: enable-auto-merge; `canWrite`: merge; else null. `checks` undefined (not loaded) or `none` counts as passing.
  - `resolveMergeMethod(allowed: MergeMethod[], chosen: MergeMethod | null, last: MergeMethod | null): MergeMethod | null`: first of `chosen`, `last` that is in `allowed`, else `allowed[0]`, else null.
  - `canDeleteBranch(pr: PullRequest, repo: Repository): boolean`: state not open, `repo.canWrite`, `pr.headRepo === pr.baseRepo`, `pr.headRef !== ''`, `pr.headRef !== repo.defaultBranch`.
  - `menuActions(pr: PullRequest, repo: Repository, primary: PrimaryControl): PullRequestAction[]`, the menu's action items in this order: `merge` ("Merge now") when primary is `enable-auto-merge` or `auto-merge-armed` and not draft; `enable-auto-merge` when open, not armed, primary is `merge`, `autoMergeAllowed`; `disable-auto-merge` when armed; `ready` when draft and primary is not `ready` (never, today; keep the rule as T3's); `draft` when open and not draft; `close` when open; `reopen` when closed; `delete-branch` when `canDeleteBranch`. Empty when `!repo.canWrite`.

- [ ] **Step 1: Write the failing tests**: one `it` per `primaryControl` branch (nine: merged, closed, conflicts over draft, draft with and without write, armed, no methods, pending with auto-merge allowed, failing without auto-merge allowed gives merge, undefined checks gives merge); `resolveMergeMethod` (chosen wins, chosen not allowed falls to last, neither falls to first, empty is null); `canDeleteBranch` (fork false, default branch false, open false, merged same-repo true); `menuActions` for an open passing PR (`['enable-auto-merge', 'draft', 'close']` with auto-merge allowed), an armed PR (`['merge', 'disable-auto-merge', 'draft', 'close']`), a merged PR (`['delete-branch']`), a closed PR (`['reopen', 'delete-branch']`), a read-only repo (`[]`).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** the four functions; first line names the T3 source: `// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDetail.logic.ts at 428d3659), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.`
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `Actions: the header's primary control, merge method and menu, decided as T3 Code decides them`

### Task 3: Two-click confirm

**Files:**
- Create: `src/actions/useInlineConfirm.ts`, `src/actions/useInlineConfirm.test.tsx`

**Interfaces:**
- Produces: `useInlineConfirm(scopeKey: string): { isArmed(action: string): boolean; props(action: string, onConfirm: () => void): { ref: ((node: HTMLElement | null) => (() => void) | undefined) | undefined; onClick(event: MouseEvent<HTMLElement>): void; onBlur(): void } }`, a port of T3's `apps/web/src/components/pullRequest/useInlineActionConfirm.ts` at `428d3659` (3000 ms timeout; capture-phase `pointerdown` outside, Escape and window `blur` disarm; a new `scopeKey` disarms).

- [ ] **Step 1: Write the failing tests** with a two-button harness: first click arms and does not call `onConfirm`; second click on the same button calls it once and disarms; Escape disarms; a `pointerdown` outside disarms; 3000 ms with fake timers disarms; clicking the other button arms that one instead; changing `scopeKey` disarms.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Port** T3's hook (first line names it).
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `Actions: a two-click confirm, ported from T3 Code`

### Task 4: The action runner

**Files:**
- Create: `src/actions/usePullRequestActions.ts`, `src/actions/usePullRequestActions.test.tsx`
- Modify: `src/queries.ts` (add `useRepository`)

**Interfaces:**
- Consumes: Tasks 1 and 2.
- Produces:
  - `useRepository(ref: PullRequestRef | undefined): UseQueryResult<Repository>`: key `['pull-requests', 'repo', owner, repo]`, `enabled` only with a token and a ref, `staleTime: 600_000`, `refetchOnMount: false`, `retryOnMount: false`, the file's `retry`.
  - `type ActionResult = { action: PullRequestAction; outcome: 'done' } | { action: PullRequestAction; outcome: 'failed'; error: GitHubWriteError }`
  - `usePullRequestActions(ref: PullRequestRef, pr: PullRequest): { repo: Repository | undefined; method: MergeMethod | null; chooseMethod(method: MergeMethod): void; pending: PullRequestAction | null; result: ActionResult | null; perform(action: PullRequestAction): void; dismissResult(): void }`
  - The last chosen method is kept in `usePluginStorage('pull-requests')` under `mergeMethod`; the per-PR choice is component state keyed by `pullRequestUrl(ref)`.
  - On success: `queryClient.invalidateQueries({ queryKey: ['pull-requests', 'pr', owner, repo, number] })`. On failure kind `refused`: the same invalidation (GitHub's state moved).
  - One action at a time per pull request: a module-level `Set<string>` of `pullRequestUrl(ref)` with one in flight; `perform` returns at once while the set has it. `result` and `pending` belong to the ref they were started for; after a ref change they read as null.

- [ ] **Step 1: Write the failing tests** (render the hook under a `QueryClientProvider` with `renderPluginComponent` or a plain wrapper as `PullRequestPanel.test.tsx` does; stub `fetch`): no token sends no request and `repo` is undefined; with a token one GraphQL request loads `repo`; `perform('merge')` twice synchronously sends one PUT (Review Focus 1); success invalidates the PR's queries (spy on `invalidateQueries`) and sets `result.outcome === 'done'`; a 405 sets `failed` with `kind: 'refused'`; `chooseMethod('rebase')` stores `mergeMethod` and a fresh hook mount resolves `rebase` when allowed; switching `ref` while a merge is pending reads `pending === null` and `result === null` for the new ref, and the old request's completion does not set a result there (Review Focus 4).
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `useRepository` and the hook; `perform` reads the token through `useStoredToken()` at call time.
- [ ] **Step 4: Run, expect PASS.**
- [ ] **Step 5: Commit** `Actions: one action at a time per pull request, with the repository's merge settings`

### Task 5: Header controls

**Files:**
- Create: `src/actions/HeaderActions.tsx`, `src/actions/HeaderActions.test.tsx`
- Modify: `src/PullRequestPanel.tsx` (the `.mrpr-header-actions` row), `src/strings.ts`, `src/styles.css`

**Interfaces:**
- Consumes: Tasks 2 to 4; `useChecks` and `checksState` for the primary control; SDK `IconButton`, `IconTooltip`, `Menu`, `MenuEntry`, `PopOut`, `Dialog`.
- Produces: `HeaderActions({ pullRequestRef, pullRequest }: { pullRequestRef: PullRequestRef; pullRequest: PullRequest })`, rendered first in `.mrpr-header-actions`, before "Open on GitHub". It renders nothing while `repo` is undefined or `!repo.canWrite` and the primary is not a badge.

Strings (`en.actions`), exact copy, most from T3:
- primary: `merge: { merge: 'Merge', squash: 'Squash and merge', rebase: 'Rebase and merge' }`, `autoMerge: 'Auto-merge ({{method}})'`, `ready: 'Ready for review'`, `confirm: { merge: 'Confirm merge?', autoMerge: 'Confirm auto-merge?', close: 'Confirm close?' }`, `pending: { merge: 'Merging...', ... one per action }`
- badges: reuse `state.merged`, `state.closed`, `badge.autoMerge`; new `conflicts: 'Conflicts'`
- menu: `more: 'More actions'`, `methodGroup: 'Merge method'`, `mergeNow: 'Merge now'`, `enableAutoMerge: 'Enable auto-merge'`, `disableAutoMerge: 'Disable auto-merge'`, `draft: 'Convert to draft'`, `close: 'Close pull request'`, `reopen: 'Reopen pull request'`, `deleteBranch: 'Delete branch'`, `refresh: 'Refresh'`
- delete dialog: `deleteTitle: 'Delete branch {{branch}}?'`, `deleteBody: 'This deletes {{branch}} from {{repo}} on GitHub. Local branches and worktrees are not changed.'`, `cancel: 'Cancel'`
- results: `done: { 'delete-branch': 'Branch deleted', 'update-branch': 'Branch updated', 'update-branch-rebase': 'Branch rebased' }` (other actions show their effect in the header and need no line); `failed: { merge: 'Could not merge this pull request', ... one per action }`; hints `noAccess: 'GitHub refused it. The saved token may not have write access to this repository (Pull requests and Contents: Read and write).'`, `badToken: 'GitHub refused the saved token.'`, `failed: 'Could not reach GitHub.'`; a `refused` failure shows GitHub's `detail` after the title.

Behavior: Merge, Auto-merge, Merge now and Close go through `useInlineConfirm` (scope key `pullRequestUrl(ref)`); Delete branch opens the `Dialog`; the rest run on click. Every control is `disabled` while `pending !== null`, and the pending control shows its pending text. The result line is `role="status"` under the header row, with a dismiss button, and clears on the next action. The method radio group shows only with two or more methods. Refresh invalidates the PR's queries without a write.

- [ ] **Step 1: Write the failing tests** (stub `fetch` and storage as `PullRequestPanel.test.tsx` does): without a token the header row is today's (no "More actions", no Merge, no GraphQL request: Review Focus 5); a read-only repo shows no controls; an open squash-only repo shows "Squash and merge", the first click shows "Confirm merge?" and sends nothing, the second sends the PUT; a 403 shows the `noAccess` hint (Review Focus 2); a 405 shows `Could not merge this pull request` and `Pull Request is not mergeable`; the menu lists the Task 2 order for an open PR; Delete branch on a merged PR asks in a dialog and sends the DELETE only on confirm; a merged PR shows the Merged badge and no Merge button; pending disables every control.
- [ ] **Step 2: Run, expect FAIL.**
- [ ] **Step 3: Implement** `HeaderActions`, its strings and styles (reuse `.mrpr-button`; the primary gets `.mrpr-button-primary` with the theme's accent; badges reuse `.mrpr-badge`), and render it in `PullRequestPanel`.
- [ ] **Step 4: Run all plugin tests, expect PASS** (the existing panel tests must not change: they run without a token).
- [ ] **Step 5: Commit** `Actions: merge and the pull request's other actions in the side panel's header, as T3 Code has them`

### Task 6: Update branch, e2e, README

**Files:**
- Modify: `src/detail/BaseBranch.tsx`, its caller in `src/PullRequestPanel.tsx`, `src/strings.ts`, `e2e/threadPullRequests.spec.ts`, `README.md`
- Test: `src/detail/BaseBranch.test.tsx` (create)

**Interfaces:**
- Consumes: `usePullRequestActions` (Task 4) from the panel, passed down.
- Produces: `BaseBranch` gains `onUpdate?: (action: 'update-branch' | 'update-branch-rebase') => void` and `updating?: boolean`. With `onUpdate`, a behind-and-not-conflicting popover adds the buttons `Update branch` and `Update with rebase` (strings `base.update`, `base.updateRebase`), disabled while `updating`. The panel passes `onUpdate` only when `repo?.canWrite`.

- [ ] **Step 1: Write the failing tests**: behind without `onUpdate` shows no buttons (today); behind with it shows both and a click calls `onUpdate('update-branch')`; conflicting shows neither.
- [ ] **Step 2: Run, expect FAIL.** Then implement, run, PASS.
- [ ] **Step 3: e2e**: extend the plugin spec's mocked GitHub (it already routes `api.github.com`) with a token in storage, the GraphQL repository answer and a `PUT .../merge` route; one test merges with the two clicks and sees the Merged badge after the refetch; with `MRPR_SHOTS` set, it saves `actions-open.png`, `actions-confirm.png`, `actions-menu.png` and `actions-merged.png`. Run on a free slot per the README (`ss -ltn | grep :43<n>` first).
- [ ] **Step 4: README**: the panel's actions, the token's write scopes, and that a read-only token keeps the panel read-only.
- [ ] **Step 5: Run all three gates; commit** `Actions: update the branch from its behind popover; end-to-end merge and the README`
