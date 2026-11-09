# Pull requests for MindRoom Chat

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

A [MindRoom Chat](https://github.com/mindroom-ai/mindroom-chat) client plugin for GitHub pull requests. Click a pull request link in a room's message, and a small card shows the pull request: its repository and number, state, title and author. From the card, the pull request opens in a side panel of the room, with its description and its changed files as a tree beside their diffs.

The card, the panel's header, the file tree and the diff view are ported from [T3 Code](https://github.com/pingdotgg/t3code) (MIT, see [NOTICE](NOTICE)).

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

Public pull requests need no token. For a private repository, or to avoid GitHub's rate limit for requests without one, a person can enter a GitHub token in the plugin's panel. The token is kept in the browser's localStorage for the signed-in account, where any script running on the page can read it. Use a fine-grained token with read access to the pull requests and contents of the repositories. Requests go to `https://api.github.com` and nowhere else; the token is sent only there, and only when one is stored.
