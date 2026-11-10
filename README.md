# Pull requests for MindRoom Chat

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [MindRoom Chat](https://github.com/mindroom-ai/mindroom-chat) client plugin for GitHub pull requests. Click a pull request link in a room's message, and a small card shows the pull request: its repository and number, state, title and author. From the card, the pull request opens in a side panel of the room, which only reads from GitHub:

- The header: the repository and number, the title, the author, when it was updated, a button that copies the `gh pr checkout` command, the base branch (with a warning when the branch is behind it or conflicts) and the head branch, the Draft, Merged, Closed and Auto-merge badges, the files and lines changed (split into code, tests, generated files and docs in a tooltip), and the checks' summary, which opens the list of checks.
- Summary: the reviewers and their verdicts, the labels, the description, the checks, and the conversation (comments, reviews and review threads) with a filter for bots and a Newest or Oldest first order.
- Timeline: the opening, each commit, each verdict, the review threads, the comments and the merge or close, in time order; choosing a commit shows its diff in the Code tab.
- Code: the changed files as a tree beside their diffs, in T3 Code's file order, with the review threads at their lines (and those not on the diff above it), a commit selector, viewed marks kept in the browser, and controls to hide test files and whitespace changes, show the diffs split or stacked, wrap lines, and collapse or expand all files.

The card and most of the panel are ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT, see [NOTICE](NOTICE)); each ported file names its T3 Code source in its first line.

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

`tsconfig.json` resolves `@mindroom/client-sdk/*` to `.mindroom-chat/src/client-sdk/*` and the shared packages through `.mindroom-chat/node_modules`.

## GitHub token

Public pull requests need no token. For a private repository, or to avoid GitHub's rate limit for requests without one, a person can enter a GitHub token in the plugin's panel. The token is kept in the browser's localStorage for the signed-in account, where any script running on the page can read it. Requests go to `https://api.github.com` and nowhere else; the token is sent only there, and only when one is stored. The plugin only reads (`GET`).

Use a fine-grained token with read-only access to these permissions of the repositories, as GitHub's [permissions required for fine-grained personal access tokens](https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens) lists them for the endpoints the plugin calls (every fine-grained token also has Metadata: read):

| Permission            | What the panel reads with it                                                                                                                                                                                                                                                                                |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pull requests: read   | the pull request (`GET /repos/{owner}/{repo}/pulls/{pull_number}`), its files, commits, reviews and review comments (`.../files`, `.../commits`, `.../reviews`, `.../comments`), and its conversation comments (`GET /repos/{owner}/{repo}/issues/{issue_number}/comments`, which Issues: read also allows) |
| Contents: read        | one commit's files (`GET /repos/{owner}/{repo}/commits/{ref}`) and how far the branch is behind its base (`GET /repos/{owner}/{repo}/compare/{basehead}`)                                                                                                                                                   |
| Commit statuses: read | the commit statuses of the head commit (`GET /repos/{owner}/{repo}/commits/{ref}/status`)                                                                                                                                                                                                                   |

GitHub has no fine-grained permission for check runs (`GET /repos/{owner}/{repo}/commits/{ref}/check-runs`, where GitHub Actions reports), so with a fine-grained token the panel shows the commit statuses and leaves the check runs out. A classic personal access token shows them: with no scope for a public repository, and with the `repo` scope for a private one, which also lets the token write to every repository its owner can.
