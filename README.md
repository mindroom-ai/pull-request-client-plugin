# Pull requests for MindRoom Chat

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [MindRoom Chat](https://github.com/mindroom-ai/mindroom-chat) client plugin for GitHub pull requests. Click a pull request link in a room's message, and the pull request opens in a side panel of the room, which reads it from GitHub and, for a viewer who may write to its repository, merges it and changes its state there; a second click, while the panel shows that pull request, opens it on GitHub. On a phone, the click shows a small card with the pull request: its repository and number, state, title and author, and from the card, the pull request opens in the side panel. The side panel shows:

- The header: the repository and number, the title, the author, when it was updated, a button that copies the `gh pr checkout` command, the base branch (with a warning when the branch is behind it or conflicts) and the head branch, the Draft, Merged, Closed and Auto-merge badges, the files and lines changed (split into code, tests, generated files and docs in a tooltip), and the checks' summary, which opens the list of checks. For a viewer who may write, the pull request's actions (below).
- Summary: the reviewers and their verdicts, the labels, the description, the checks, and the conversation (comments, reviews and review threads) with a filter for bots and a Newest or Oldest first order.
- Timeline: the opening, each commit, each verdict, the review threads, the comments and the merge or close, in time order; choosing a commit shows its diff in the Code tab.
- Code: the changed files as a tree beside their diffs, in T3 Code's file order and in a column whose edge drags its width (kept in the browser), with the review threads at their lines (and those not on the diff above it), a commit selector, viewed marks kept in the browser, and controls to hide test files and whitespace changes, show the diffs split or stacked, wrap lines, and collapse or expand all files.

A pull request's state has GitHub's colors, the same in every theme, wherever it shows: green for open, purple for merged, red for closed and gray for a draft.

The card and most of the panel are ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT, see [NOTICE](NOTICE)); each ported file names its T3 Code source in its first line.

## Actions

With a stored GitHub token whose account may write to the repository (GitHub's `viewerPermission` is write, maintain or admin), the panel's header has T3 Code's pull request actions. Without a token, or for an account that may only read, the header is as before, with no action; without a token, the panel does not ask GraphQL either.

- One primary control: Merge, labeled with the merge method (Merge, Squash and merge or Rebase and merge); Auto-merge with the method instead, while the checks run or fail, the repository allows auto-merge and GitHub would not merge at once (GitHub refuses to turn auto-merge on for a pull request it can merge now, so there the control is Merge and the menu has no Enable auto-merge); Ready for review for a draft; and a Conflicts badge for a branch that conflicts with its base. A merged or closed pull request, or one with auto-merge on, keeps its badge and has no primary control.
- A More actions menu beside it: the merge method, when the repository allows more than one (the last one chosen is kept for the account), then what applies of Merge now, Enable auto-merge, Disable auto-merge, Ready for review, Convert to draft, Close pull request, Reopen pull request and Delete branch, and Refresh. Delete branch shows for a merged or closed pull request whose branch is in the same repository, is not its default branch and still ends at the pull request's last commit, and asks in a dialog first. The panel asks GitHub where the branch points now, so a branch that is gone (deleted here or elsewhere), was pushed to since, or was made anew under the same name is not offered; and GitHub deletes it only while it still points at that commit (`updateRefs` with the commit as `beforeOid`), so a push in between is refused. A branch found already gone counts as deleted.
- In the base branch's warning, for a branch that is behind its base and that GitHub found mergeable: Update branch, which merges the base into the branch, and Update with rebase. GitHub makes the branch's new commit after it answers, so the update runs on ("Updating branch...") until GitHub shows the pull request's new head, which the panel asks at once and then every two seconds, for half a minute at most. Then the line says the branch was updated and the panel has the new head, which a merge after it sends; if no new head shows in that time, the line says only that the update was requested.

Merge, Merge now, auto-merge and Close take two clicks: the first turns the button into "Confirm merge?" (or "Confirm auto-merge?", "Confirm close?"), and a second within 3 s runs it; Escape, a click elsewhere or the focus leaving it disarms it. The rest run at once. One action runs at a time per pull request, also across a panel closed and opened again, and every control waits while it does; a line under the header says what runs, then why GitHub refused (with a hint when the token may lack write access, and GitHub's reason after it), or that a branch was updated, rebased or deleted. An outcome stays with its pull request until dismissed, so one that came while the panel showed another shows when that one is shown again. After every action, whatever came of it, the panel loads the pull request again, asking GitHub rather than the browser's cache, and the controls wait until that read is in, so they never offer the pull request as it was before the action. Merge, auto-merge and the updates send the head commit the panel shows, so GitHub refuses them if the branch moved since.

## Pull requests of a thread

A thread can be linked to the pull requests it works on. MindRoom's backend plugin `pull-requests` writes the links into the room's state, one state event per thread and pull request, which this plugin only reads:

- type: `com.mindroom.thread.pull_request`
- state key: `["<thread root event ID>","<owner>/<repo>#<number>"]` as compact JSON (no spaces), with the owner and repository in lower case
- content: `{"url","set_by","set_at"}`: the pull request's URL, `https://github.com/<owner>/<repo>/pull/<number>` with the owner and repository in lower case, who linked it, and when (UTC, ISO 8601); a pull request that was unlinked has the content `{}`

A linked pull request shows as a chip: its state's icon, its number and, while a GitHub token is stored, the mark of its checks, with the repository's name before the number when the room's links span more than one repository.

- On a thread's card in the Compact view: the chips of the first two pull requests linked to it (one on a phone), then `+N` for the rest. A click on a chip opens the thread and the pull request in the side panel; elsewhere on the card, the click opens the thread as before. These chips take no focus, since the card is one button.
- Under the room header, while a thread is open: a chip for each of its pull requests, as a button that opens the pull request in the side panel. While the panel is open, the chip of the pull request it shows is pressed.

A pointer that rests on a chip for 150 ms, on a card or in the strip, opens a card with the pull request at a glance; a chip in the strip also opens it when the keyboard focuses it. It opens only where the pointer can hover finely (`(hover: hover) and (pointer: fine)`, a mouse or a trackpad): on a touch screen, a tap on a chip does what it did before. The card shows:

- the repository and the number, the state, and the Auto-merge badge
- the title, in three lines at most
- the author, when the pull request was opened, and when it was updated, merged or closed
- the head and base branches, with a warning when the branch conflicts with its base or is behind it
- the lines, files, commits and comments
- the checks' summary, when the chip shows their mark (an open pull request, with a token)
- each reviewer's latest verdict, and the reviewers and teams still asked for a review, in one line: an avatar with the verdict on its corner as in the panel, six at most and the count of the rest, with a token
- the first five labels, each cut to one short line, and the count of the rest
- a note that a click opens the pull request in the side panel, when it does

Until GitHub sent the pull request, the card shows the repository, the number and that it loads; when GitHub refused, why. It only reads: it takes no pointer and no focus, and closes when the pointer leaves, on a click and on Escape. It opens below the chip, or above it when the chip is in the lower half of the window, and stays inside the window as its content arrives.

A thread's agent can also work in a git worktree, in its workspace or outside it. MindRoom's backend plugin `thread-worktree` records it in the room's state, one state event per thread, which this plugin only reads:

- type: `com.mindroom.thread.worktree`
- state key: the thread's root event ID, as it is (not JSON)
- content: `{"path","branch","repo","set_by","set_at"}`: the worktree's directory, relative to the agent's workspace or absolute for one outside it (POSIX separators, no `..` part), its branch and its repository's name (each empty when it has none), who set it, and when; a thread without a worktree has the content `{}`

The worktree shows as its branch: the branch icon and the branch's name, or the last part of the path when the branch is empty, with the path, the repository and the branch in its tooltip. In a room whose links, or whose worktrees, span several repositories, the repository's name comes before the branch's, as on a pull request chip, so its threads can be told apart; the two names share the room the branch has alone. A path the backend plugin reads as no worktree shows none, and a branch or repository it reads as none is left out.

- On a thread's card in the Compact view: in the place of the chips, when no pull request is linked to the thread; with linked pull requests, the card shows only their chips. A click on the branch opens the thread, as anywhere else on the card.
- Under the room header, while a thread is open: before the chips of its pull requests, as text, not a button; alone when the thread has no linked pull request.

## Thread details

A thread with a linked pull request or a worktree has details, which MindRoom Chat shows in the hover card of its card in the Compact view, when a pointer rests on the card, and as the first group of the thread's menu. They are rows of text, with no control and no link:

- Each pull request linked to the thread, in the order they were linked, also those past the two its card shows: its state's icon, its repository and number and, while a GitHub token is stored, the mark of its checks; once GitHub has answered, its title (two lines at most), its head and base branches (`head → base`, with the fork's owner before the head of a pull request from a fork, and long names shortened in the middle), and the lines and files it changes, its author and when it was updated.
- The thread's worktree: its branch, when it has one, and its path.

The details ask GitHub through the chips' own requests: a hover asks GitHub nothing for a pull request whose chip has loaded or was refused, however long ago, while those past the card's two load on the first hover, and the menu's details load as the hover card's do.

## Build it into a client

The plugin is built into a MindRoom Chat client by listing its directory in `MINDROOM_CLIENT_PLUGINS` when the client is built or run (see "Client plugins" in the client's `docs/architecture.md`):

```sh
MINDROOM_CLIENT_PLUGINS=/path/to/pull-request-client-plugin just build
```

Run `npm install` here first. `.npmrc` sets `legacy-peer-deps`, so that the Pierre packages' React peer range installs no second React; React, folds and TanStack Query come from the client.

## Tests and types

Every pull request and every push to `main` runs the unit tests, the type check and Prettier against the client's `main` (`.github/workflows/ci.yml`).

The tests run with the client's vitest, from the client's checkout:

```sh
MINDROOM_CLIENT_PLUGINS=/path/to/pull-request-client-plugin nix develop -c npx vitest run /path/to/pull-request-client-plugin/src
```

The `/src` filter matters: without it, vitest also collects the client's own tests through the `.mindroom-chat` link.

`npm run typecheck` uses the client's TypeScript and its source types. For that, link the client's checkout as `.mindroom-chat` in this directory (it is git-ignored):

```sh
ln -s /path/to/mindroom-chat .mindroom-chat
```

`tsconfig.json` resolves `@mindroom/client-sdk/*` to `.mindroom-chat/src/client-sdk/*` and the shared packages through `.mindroom-chat/node_modules`; for the end-to-end specs in `e2e/`, `@mindroom/e2e/*` to the client's `e2e/helpers/` and `@playwright/test` to the client's copy.

The end-to-end spec `e2e/threadPullRequests.spec.ts` runs in the client's Playwright against a production build with this plugin, on an e2e slot of its own (the client's `docs/development.md`, "A client plugin in its own repository"). From the client's checkout, with absolute directories:

```sh
E2E_PLUGIN_DIRS=/path/to/pull-request-client-plugin MINDROOM_CLIENT_PLUGINS=/path/to/pull-request-client-plugin just e2e-slot 3 --preview npx playwright test --project=pull-request-client-plugin
```

The page answers GitHub's API itself, so no request leaves the test. With `MRPR_SHOTS=<directory>` (an absolute one: the run's working directory is the slot's snapshot), it saves screenshots of a thread's pull requests: the Compact view in the light and dark themes, the hover card of a chip on a card and of one in the strip in both themes, a hover card with six reviewers and five labels, an open thread with its strip and the panel, and the Compact view on a phone; of a thread's branch on its card and in the strip of the open thread; and of the panel's actions: the header with Merge (`actions-open.png`), the More actions menu (`actions-menu.png`), the armed Confirm merge? (`actions-confirm.png`), the header after the merge (`actions-merged.png`), the dialog before the branch goes (`actions-delete-dialog.png`), the line with GitHub's reason for a refused merge (`actions-refused.png`), the header of a closed pull request (`actions-closed.png`), the base branch's warning with Update branch (`actions-behind.png`), the header after the update (`actions-updated.png`) and the header with its controls on a phone (`actions-phone.png`).

## GitHub token

Public pull requests need no token. For a private repository, or to avoid GitHub's rate limit for requests without one, a person can enter a GitHub token in the plugin's panel. The token is kept in the browser's localStorage for the signed-in account, where any script running on the page can read it. Requests go to `https://api.github.com` and nowhere else; the token is sent only there, and only when one is stored. The plugin reads with `GET`, and asks GraphQL (`POST https://api.github.com/graphql`, only with a token) for the repository's merge settings and whether the account may write, and for where the branch of a merged or closed pull request points; it writes only when a person runs one of the panel's actions.

The chips of a thread's pull requests ask GitHub for each pull request once it has been on screen: one request each, and two more for its checks when a token is stored. With a token, a chip's hover card asks for the reviews when it opens, usually one request (one per 100 reviews), and uses that answer for two minutes; a chip that is only on screen asks for none, and without a token the card asks for no reviews and shows none. A chip asks again when it shows after its answer is more than two minutes old, and not when the tab regains focus. Without a token, GitHub allows 60 requests an hour for the address, shared with the panel, and the chips show no checks marks. After GitHub answers with its rate limit, the plugin asks it nothing more until the limit resets.

Use a fine-grained token with read-only access to these permissions of the repositories, as GitHub's [permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) lists them for the endpoints the plugin calls (every fine-grained token also has Metadata: read):

| Permission            | What the panel reads with it                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull requests: read   | the pull request (`GET /repos/{owner}/{repo}/pulls/{pull_number}`), its files, commits, reviews and review comments (`.../files`, `.../commits`, `.../reviews`, `.../comments`), and its conversation comments (`GET /repos/{owner}/{repo}/issues/{issue_number}/comments`, which Issues: read also allows) |
| Contents: read        | one commit's files (`GET /repos/{owner}/{repo}/commits/{ref}`) and how far the branch is behind its base (`GET /repos/{owner}/{repo}/compare/{basehead}`)                                                                                                                                                   |
| Commit statuses: read | the commit statuses of the head commit (`GET /repos/{owner}/{repo}/commits/{ref}/status`)                                                                                                                                                                                                                   |

For the panel's actions, the token needs write access: a fine-grained token with Pull requests: Read and write (merge, auto-merge, ready for review, draft, close, reopen and update branch) and Contents: Read and write (merge, update branch and delete branch), or a classic token with the `repo` scope. A token with read-only access keeps the panel read-only in effect: the header shows the actions when the account may write, since GitHub's `viewerPermission` is the account's and not the token's, but GitHub refuses each one, and the line under the header says the token may not have write access.

GitHub has no fine-grained permission for check runs (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, where GitHub Actions reports), so with a fine-grained token the panel shows the commit statuses and leaves the check runs out. A classic personal access token shows them: with no scope for a public repository, and with the `repo` scope for a private one, which also lets the token write to every repository its owner can.
