# Pull requests for MindRoom Chat

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [MindRoom Chat](https://github.com/mindroom-ai/mindroom-chat) client plugin for GitHub pull requests. Click a pull request link in a room's message, and a small card shows the pull request: its repository and number, state, title and author. From the card, the pull request opens in a side panel of the room, which only reads from GitHub:

- The header: the repository and number, the title, the author, when it was updated, a button that copies the `gh pr checkout` command, the base branch (with a warning when the branch is behind it or conflicts) and the head branch, the Draft, Merged, Closed and Auto-merge badges, the files and lines changed (split into code, tests, generated files and docs in a tooltip), and the checks' summary, which opens the list of checks.
- Summary: the reviewers and their verdicts, the labels, the description, the checks, and the conversation (comments, reviews and review threads) with a filter for bots and a Newest or Oldest first order.
- Timeline: the opening, each commit, each verdict, the review threads, the comments and the merge or close, in time order; choosing a commit shows its diff in the Code tab.
- Code: the changed files as a tree beside their diffs, in T3 Code's file order, with the review threads at their lines (and those not on the diff above it), a commit selector, viewed marks kept in the browser, and controls to hide test files and whitespace changes, show the diffs split or stacked, wrap lines, and collapse or expand all files.

The card and most of the panel are ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT, see [NOTICE](NOTICE)); each ported file names its T3 Code source in its first line.

## Pull requests of a thread

A thread can be linked to the pull requests it works on. MindRoom's backend plugin `pull-requests` writes the links into the room's state, one state event per thread and pull request, which this plugin only reads:

- type: `com.mindroom.thread.pull_request`
- state key: `["<thread root event ID>","<owner>/<repo>#<number>"]` as compact JSON (no spaces), with the owner and repository in lower case
- content: `{"url","set_by","set_at"}`: the pull request's URL, `https://github.com/<owner>/<repo>/pull/<number>` with the owner and repository in lower case, who linked it, and when (UTC, ISO 8601); a pull request that was unlinked has the content `{}`

A linked pull request shows as a chip: its state's icon, its number and, while a GitHub token is stored, the mark of its checks, with the repository's name before the number when the room's links span more than one repository.

- On a thread's card in the Compact view: the chips of the first two pull requests linked to it (one on a phone), then `+N` for the rest. A click on a chip opens the thread and the pull request in the side panel; elsewhere on the card, the click opens the thread as before. These chips take no focus, since the card is one button.
- Under the room header, while a thread is open: a chip for each of its pull requests, as a button that opens the pull request in the side panel. While the panel is open, the chip of the pull request it shows is pressed.

A thread's agent can also work in a git worktree, in its workspace or outside it. MindRoom's backend plugin `thread-worktree` records it in the room's state, one state event per thread, which this plugin only reads:

- type: `com.mindroom.thread.worktree`
- state key: the thread's root event ID, as it is (not JSON)
- content: `{"path","branch","repo","set_by","set_at"}`: the worktree's directory, relative to the agent's workspace or absolute for one outside it (POSIX separators, no `..` part), its branch and its repository's name (each empty when it has none), who set it, and when; a thread without a worktree has the content `{}`

The worktree shows as its branch: the branch icon and the branch's name, or the last part of the path when the branch is empty, with the path, the repository and the branch in its tooltip. In a room whose links, or whose worktrees, span several repositories, the repository's name comes before the branch's, as on a pull request chip, so its threads can be told apart; the two names share the room the branch has alone. A path the backend plugin reads as no worktree shows none, and a branch or repository it reads as none is left out.

- On a thread's card in the Compact view: in the place of the chips, when no pull request is linked to the thread; with linked pull requests, the card shows only their chips. A click on the branch opens the thread, as anywhere else on the card.
- Under the room header, while a thread is open: before the chips of its pull requests, as text, not a button; alone when the thread has no linked pull request.

## Build it into a client

The plugin is built into a MindRoom Chat client by listing its directory in `MINDROOM_CLIENT_PLUGINS` when the client is built or run (see "Client plugins" in the client's `docs/architecture.md`):

```sh
MINDROOM_CLIENT_PLUGINS=/path/to/pull-request-client-plugin just build
```

Run `npm install` here first. `.npmrc` sets `legacy-peer-deps`, so that the Pierre packages' React peer range installs no second React; React, folds and TanStack Query come from the client.

## Tests and types

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

The page answers GitHub's API itself, so no request leaves the test. With `MRPR_SHOTS=<directory>` (an absolute one: the run's working directory is the slot's snapshot), it saves screenshots of a thread's pull requests: the Compact view in the light and dark themes, an open thread with its strip and the panel, and the Compact view on a phone; and of a thread's branch on its card and in the strip of the open thread.

## GitHub token

Public pull requests need no token. For a private repository, or to avoid GitHub's rate limit for requests without one, a person can enter a GitHub token in the plugin's panel. The token is kept in the browser's localStorage for the signed-in account, where any script running on the page can read it. Requests go to `https://api.github.com` and nowhere else; the token is sent only there, and only when one is stored. The plugin only reads (`GET`).

The chips of a thread's pull requests ask GitHub for each pull request once it has been on screen: one request each, and two more for its checks when a token is stored. A chip asks again when it shows after its answer is more than two minutes old, and not when the tab regains focus. Without a token, GitHub allows 60 requests an hour for the address, shared with the panel, and the chips show no checks marks. After GitHub answers with its rate limit, the plugin asks it nothing more until the limit resets.

Use a fine-grained token with read-only access to these permissions of the repositories, as GitHub's [permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) lists them for the endpoints the plugin calls (every fine-grained token also has Metadata: read):

| Permission            | What the panel reads with it                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull requests: read   | the pull request (`GET /repos/{owner}/{repo}/pulls/{pull_number}`), its files, commits, reviews and review comments (`.../files`, `.../commits`, `.../reviews`, `.../comments`), and its conversation comments (`GET /repos/{owner}/{repo}/issues/{issue_number}/comments`, which Issues: read also allows) |
| Contents: read        | one commit's files (`GET /repos/{owner}/{repo}/commits/{ref}`) and how far the branch is behind its base (`GET /repos/{owner}/{repo}/compare/{basehead}`)                                                                                                                                                   |
| Commit statuses: read | the commit statuses of the head commit (`GET /repos/{owner}/{repo}/commits/{ref}/status`)                                                                                                                                                                                                                   |

GitHub has no fine-grained permission for check runs (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, where GitHub Actions reports), so with a fine-grained token the panel shows the commit statuses and leaves the check runs out. A classic personal access token shows them: with no scope for a public repository, and with the `repo` scope for a private one, which also lets the token write to every repository its owner can.
