import { join } from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { loginWithPassword } from '@mindroom/e2e/auth';
import { createRoom } from '@mindroom/e2e/createRoom';
import {
  DISPOSABLE_HOMESERVER as HOMESERVER,
  disposableHomeserverIsUp,
  registerDisposableUser,
  type DisposableUser,
} from '@mindroom/e2e/disposableAccounts';
import {
  joinRoom,
  matrixFetch,
  registerAgentAccount,
  sendRoomMessage,
  sendStateEvent,
  type MatrixSession,
} from '@mindroom/e2e/matrix';
import { touch } from '@mindroom/e2e/touch';

// A thread's pull requests in a production build with this plugin, against the disposable
// homeserver, with GitHub's API answered by the page (no request leaves the test). The links are
// the room state events MindRoom's backend plugin writes; here the room's creator writes them. A
// thread's card in the Compact view shows a chip per pull request, two at most (one on a phone) and
// the count of the rest; a click on a chip opens the thread and the pull request in the side
// panel; the strip under the room header has the thread's chips as buttons, the panel's pressed;
// a mouse that rests on a chip, on a card or in the strip, opens its hover card beside it;
// a link written or cleared while the room is open shows on its card at once, also after a gap in
// the room's sync; the room's six threads leave the SDK's emitters within their listener limit; and
// a thread's worktree, which MindRoom's `thread-worktree` backend plugin writes, shows as its
// branch on its card and in the strip until it is cleared; a thread's pull requests show as its
// details in the card's hover card and, on a phone, in the menu a long press opens; and a viewer
// who can write merges a pull request from the panel's header with two clicks (and is asked before
// its branch goes), sees GitHub's reason for a refused merge, chooses the merge method that the
// next pull request and the next page load keep, closes and reopens a pull request, and updates a
// branch behind its base from the base branch's warning (and is told only that the update was
// requested when GitHub has not made it yet), with the header's controls on a phone; and without
// a token, with the GitHub account connected in the room's MindRoom server (which the page also
// answers), the chips, the panel and a merge go through that server, and the page asks GitHub
// nothing itself.
// Set MRPR_SHOTS=<directory> to save the screenshots of the pull request.

const LINK_EVENT = 'com.mindroom.thread.pull_request';
const WORKTREE_EVENT = 'com.mindroom.thread.worktree';
const PASSWORD = 'thread-pull-requests-password';
const RUN = Date.now().toString(36);
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };
const PHONE_CONTEXT = {
  viewport: PHONE,
  deviceScaleFactor: 2,
  hasTouch: true,
  isMobile: true,
  serviceWorkers: 'block',
} as const;

test.use({ viewport: DESKTOP, deviceScaleFactor: 2, serviceWorkers: 'block' });

// GitHub's side: the pull requests the threads link to.

type Checks = 'running' | 'passing' | 'failing' | 'none';
type Pull = {
  repo: 'webapp' | 'api';
  number: number;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  checks: Checks;
  branch: string;
  /** The base branch; `main` when absent. */
  base?: string;
  /** The lines it adds and deletes, and the files it changes. */
  size: [number, number, number];
  author: string;
  body: string;
  labels?: string[];
  approvedBy?: string;
  /** Asked for a review that has not come yet. */
  reviewers?: string[];
  comment?: { author: string; body: string };
};

const PULLS = {
  sessionStore: {
    repo: 'webapp',
    number: 412,
    title: 'Store sessions in Redis',
    state: 'open',
    checks: 'running',
    branch: 'redis-sessions',
    size: [184, 37, 7],
    author: 'acme-builder',
    body: 'Moves the session store from Postgres to Redis behind the `SessionStore` interface.',
    labels: ['backend', 'performance'],
    reviewers: ['platform-lead'],
    comment: {
      author: 'platform-lead',
      body: 'Keep the Postgres fallback until the cache is warm after a deploy.',
    },
  },
  tokenEndpoint: {
    repo: 'api',
    number: 87,
    title: 'Read sessions from Redis in the token endpoint',
    state: 'open',
    checks: 'passing',
    branch: 'redis-sessions',
    size: [42, 9, 3],
    author: 'acme-builder',
    body: 'The token endpoint reads the session through the new store, with the same expiry.',
    labels: ['backend'],
    approvedBy: 'api-reviewer',
  },
  darkMode: {
    repo: 'webapp',
    number: 418,
    title: 'Dark mode tokens and toggle for the settings page',
    state: 'draft',
    checks: 'none',
    branch: 'settings-dark-mode',
    size: [326, 58, 12],
    author: 'acme-builder',
    body: 'Adds the dark colour tokens and the toggle. Tests for the toggle follow.',
    labels: ['frontend'],
  },
  checkoutClock: {
    repo: 'webapp',
    number: 405,
    title: "Pin the payment mock's clock in the checkout test",
    state: 'open',
    checks: 'failing',
    branch: 'checkout-test-clock',
    size: [11, 4, 1],
    author: 'acme-builder',
    body: 'The checkout test read the wall clock, so a slow runner saw an expired card.',
    // Enough reviewers and labels to fill its hover card.
    labels: [
      'tests',
      'payments-and-billing',
      'continuous-integration',
      'flaky-test-investigation',
      'needs-backport-to-release',
    ],
    reviewers: [1, 2, 3, 4, 5].map((index) => `checkout-payments-reviewer-${index}`),
    approvedBy: 'checkout-payments-reviewer-lead',
  },
  rateLimit: {
    repo: 'api',
    number: 79,
    title: 'Rate limit the public API per token',
    state: 'merged',
    checks: 'passing',
    branch: 'rate-limit-per-token',
    size: [268, 15, 9],
    author: 'acme-builder',
    body: 'A token bucket per API token, 600 requests a minute.',
    approvedBy: 'api-reviewer',
  },
  changelog: {
    repo: 'webapp',
    number: 409,
    title: 'Changelog for 2026.11.3',
    state: 'merged',
    checks: 'passing',
    branch: 'changelog-2026-11-3',
    size: [23, 0, 1],
    author: 'platform-lead',
    body: 'Release notes for 2026.11.3.',
  },
  ipRateLimit: {
    repo: 'api',
    number: 83,
    title: 'Rate limit the public API per IP address',
    state: 'closed',
    checks: 'none',
    branch: 'rate-limit-per-client-ip-address',
    base: 'release/2026.11-api-hardening',
    size: [96, 41, 4],
    author: 'acme-builder',
    body: 'Superseded by the limit per token.',
  },
  webhookRetries: {
    repo: 'webapp',
    number: 421,
    title: 'Retry failed webhook deliveries with backoff',
    state: 'open',
    checks: 'passing',
    branch: 'webhook-retries',
    size: [151, 22, 5],
    author: 'acme-builder',
    body: 'Retries a failed delivery five times with exponential backoff and logs each attempt.',
    labels: ['backend'],
  },
} satisfies Record<string, Pull>;
const ALL_PULLS: Pull[] = Object.values(PULLS);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const headSha = (pull: Pull) =>
  `${pull.repo === 'api' ? 'a' : 'b'}${String(pull.number).padStart(39, '0')}`;
// The head after an update of the branch, which the checks and the comparison know as well.
const updatedSha = (pull: Pull) => `c${headSha(pull).slice(1)}`;
const hasHead = (pull: Pull, sha: string) => sha === headSha(pull) || sha === updatedSha(pull);
const repositoryId = (pull: Pull) => `R_${pull.repo}`;
const pullId = (pull: Pull) => `PR_${pull.repo}_${pull.number}`;
const pullPath = (pull: Pull) => `/repos/acme/${pull.repo}/pulls/${pull.number}`;
const gitHubUser = (login: string) => ({
  login,
  avatar_url: null,
  html_url: `https://github.com/${login}`,
  type: 'User',
});

const apiPull = (pull: Pull, head: string = headSha(pull)) => {
  const repo = { full_name: `acme/${pull.repo}`, node_id: repositoryId(pull) };
  const done = pull.state === 'merged' || pull.state === 'closed';
  return {
    node_id: pullId(pull),
    number: pull.number,
    title: pull.title,
    state: done ? 'closed' : 'open',
    draft: pull.state === 'draft',
    body: pull.body,
    user: gitHubUser(pull.author),
    labels: (pull.labels ?? []).map((name) => ({ name, color: '0e8a16' })),
    requested_reviewers: (pull.reviewers ?? []).map(gitHubUser),
    requested_teams: [],
    mergeable: done ? null : true,
    // A required check that runs or fails keeps GitHub from merging at once.
    mergeable_state: done
      ? null
      : pull.checks === 'running' || pull.checks === 'failing'
      ? 'blocked'
      : 'clean',
    auto_merge: null,
    head: { sha: head, ref: pull.branch, repo },
    base: { ref: pull.base ?? 'main', repo },
    merged_at: pull.state === 'merged' ? ago(95) : null,
    closed_at: done ? ago(95) : null,
    comments: pull.comment ? 1 : 0,
    review_comments: 0,
    commits: 3,
    created_at: ago(26 * 60),
    updated_at: ago(42),
    additions: pull.size[0],
    deletions: pull.size[1],
    changed_files: pull.size[2],
    html_url: `https://github.com/acme/${pull.repo}/pull/${pull.number}`,
  };
};

const checkRun = (pull: Pull, name: string, conclusion: 'success' | 'failure' | null) => ({
  name,
  status: conclusion === null ? 'in_progress' : 'completed',
  conclusion,
  started_at: ago(30),
  completed_at: conclusion === null ? null : ago(24),
  html_url: `https://github.com/acme/${pull.repo}/actions/runs/${pull.number}01`,
  output: { title: null },
});

const CHECK_RUNS: Record<Checks, [string, 'success' | 'failure' | null][]> = {
  running: [
    ['build', 'success'],
    ['unit tests', 'success'],
    ['e2e', null],
  ],
  passing: [
    ['build', 'success'],
    ['unit tests', 'success'],
    ['e2e', 'success'],
  ],
  failing: [
    ['build', 'success'],
    ['e2e (chromium)', 'failure'],
    ['e2e (safari)', 'failure'],
  ],
  none: [],
};

/**
 * GitHub's answer to a GET of `pathname`, or undefined for a path these pull requests lack; the
 * pull requests in `moved` (by path) have been merged, closed or reopened in the page since it
 * loaded, those in `behind` (by path) are that many commits behind their base, and those in
 * `heads` (by path) have that head since their branch was updated.
 */
const gitHubAnswer = (
  pathname: string,
  moved: ReadonlyMap<string, Pull['state']>,
  behind: Readonly<Record<string, number>>,
  heads: ReadonlyMap<string, string>
): unknown => {
  const [, repo, kind, id, part] =
    /^\/repos\/acme\/([^/]+)\/([a-z]+)\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname) ?? [];
  if (kind === 'compare') {
    const pull = ALL_PULLS.find(
      (candidate) => candidate.repo === repo && hasHead(candidate, id.split('...')[1] ?? '')
    );
    const by = pull ? behind[pullPath(pull)] ?? 0 : 0;
    return { behind_by: by, ahead_by: 3 };
  }
  if (kind === 'commits') {
    const pull = ALL_PULLS.find((candidate) => candidate.repo === repo && hasHead(candidate, id));
    if (!pull) return undefined;
    const runs = CHECK_RUNS[pull.checks].map(([name, conclusion]) =>
      checkRun(pull, name, conclusion)
    );
    if (part === 'check-runs') return { total_count: runs.length, check_runs: runs };
    if (part === 'status') return { state: 'pending', total_count: 0, statuses: [] };
    return undefined;
  }
  const pull = ALL_PULLS.find(
    (candidate) => candidate.repo === repo && String(candidate.number) === id
  );
  if (!pull) return undefined;
  if (kind === 'pulls' && part === undefined) {
    const state = moved.get(pathname);
    return apiPull(state ? { ...pull, state } : pull, heads.get(pathname));
  }
  if (kind === 'pulls' && part === 'reviews') {
    return pull.approvedBy
      ? [
          {
            id: pull.number * 10,
            state: 'APPROVED',
            user: gitHubUser(pull.approvedBy),
            body: '',
            commit_id: headSha(pull),
            submitted_at: ago(50),
            html_url: `https://github.com/acme/${pull.repo}/pull/${pull.number}#review`,
          },
        ]
      : [];
  }
  if (kind === 'issues' && part === 'comments') {
    return pull.comment
      ? [
          {
            id: pull.number * 100,
            user: gitHubUser(pull.comment.author),
            body: pull.comment.body,
            created_at: ago(60),
            html_url: `https://github.com/acme/${pull.repo}/pull/${pull.number}#comment`,
          },
        ]
      : [];
  }
  if (kind === 'pulls' && ['comments', 'files', 'commits'].includes(part ?? '')) return [];
  return undefined;
};

const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': 'accept, authorization, content-type, x-github-api-version',
  'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE',
};

// The repository's settings as GraphQL gives them: the lead may write, with every merge method.
const REPOSITORY = {
  viewerPermission: 'WRITE',
  mergeCommitAllowed: true,
  squashMergeAllowed: true,
  rebaseMergeAllowed: true,
  autoMergeAllowed: true,
  defaultBranchRef: { name: 'main' },
};

type Write = { method: string; pathname: string; body: unknown };
type Answer = { status: number; json: unknown };

// The room's MindRoom server, which the page reaches at `mindroom.computers.apiUrl`.
const MINDROOM = 'http://127.0.0.1:29597';
// The GitHub account the lead connected in MindRoom.
const CONNECTED_LOGIN = 'platform-lead';

/**
 * Answers the routes of the room's MindRoom server at `origin` that the page uses with the lead
 * connected to GitHub there: the sign-in (`POST /api/client-sessions`), the connection's status
 * and GitHub's requests, which `answer` answers as GitHub, as MindRoom passes them on.
 */
const stubMindroom = async (
  page: Page,
  origin: string,
  answer: (method: string, pathname: string, body: unknown) => Answer
) => {
  await page.route(`${origin}/**`, async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const { pathname } = new URL(request.url());
    if (pathname === '/api/client-sessions' && request.method() === 'POST') {
      const expires = Math.floor(Date.now() / 1000) + 3600;
      await route.fulfill({
        headers: CORS,
        json: { session_token: 'mindroom-session', expires_at: expires },
      });
    } else if (pathname === '/api/github/status') {
      await route.fulfill({ headers: CORS, json: { connected: true, login: CONNECTED_LOGIN } });
    } else if (pathname === '/api/github/request') {
      const sent = request.postDataJSON() as { method: string; path: string; body?: unknown };
      const github = new URL(`https://api.github.com${sent.path}`);
      const { status, json } = answer(sent.method, github.pathname, sent.body ?? null);
      await route.fulfill({ headers: CORS, json: { status, body: json, headers: {} } });
    } else {
      await route.fulfill({ status: 404, headers: CORS, json: { error: 'not_found' } });
    }
  });
};

/**
 * Answers GitHub's API in the page; the returned list collects the paths it had no answer for.
 * It answers the repository's GraphQL query, GraphQL's read of where a branch points (at its
 * pull request's head, until the branch is deleted, with that pull request's state) and the
 * writes, which `writes` collects: a merge, after which the pull request reads as merged; a
 * close or a reopen, after which it reads so; GraphQL's update of a branch, whose answer names
 * the pull request's new head, behind no more; and GraphQL's deletion of a branch, after which
 * it is gone. A write in `refuse` (by method and path) GitHub refuses with 405 and its message;
 * a pull request in `behind` (by path) starts that many commits behind its base. With
 * `lateUpdate` GitHub makes an update of a branch after it answers: its answer names the old
 * head, the first read of the pull request after it still has that head, and the next one has
 * the new head.
 */
const stubGitHub = async (
  page: Page,
  writes: Write[] = [],
  {
    refuse = {},
    behind = {},
    lateUpdate = false,
    mindroom,
  }: {
    refuse?: Record<string, string>;
    behind?: Record<string, number>;
    lateUpdate?: boolean;
    mindroom?: string;
  } = {}
): Promise<string[]> => {
  const unanswered: string[] = [];
  const moved = new Map<string, Pull['state']>();
  const behindNow = { ...behind };
  // The branches deleted in the page, as `refs/heads/<name>` after the repository's id.
  const deleted = new Set<string>();
  // The heads of the branches updated in the page, by the pull request's path, and the updates
  // GitHub has taken but not made yet, with the reads that still show the old head.
  const heads = new Map<string, string>();
  const updating = new Map<string, { reads: number; sha: string }>();
  // GitHub's answer to `method` on `pathname`, with the request's `body`.
  const answer = (method: string, pathname: string, body: unknown): Answer => {
    if (method !== 'GET') {
      const query = (body as { query?: unknown } | null)?.query;
      if (
        pathname === '/graphql' &&
        typeof query === 'string' &&
        query.includes('viewerPermission')
      ) {
        return { status: 200, json: { data: { repository: REPOSITORY } } };
      }
      const graphql = pathname === '/graphql' && typeof query === 'string' ? query : '';
      const variables = (body as { variables?: Record<string, unknown> } | null)?.variables ?? {};
      if (graphql.includes('ref(qualifiedName')) {
        const branch = ALL_PULLS.find(
          (candidate) =>
            repositoryId(candidate) === variables.repositoryId &&
            `refs/heads/${candidate.branch}` === variables.ref
        );
        const gone =
          !branch || deleted.has(`${String(variables.repositoryId)} ${String(variables.ref)}`);
        const ref = gone
          ? null
          : { target: { oid: heads.get(pullPath(branch)) ?? headSha(branch) } };
        // With the state of the pull request it asks about, as GitHub has it now.
        const asked = ALL_PULLS.find(
          (candidate) => candidate.repo === variables.repo && candidate.number === variables.number
        );
        const now = asked ? moved.get(pullPath(asked)) ?? asked.state : undefined;
        const state = now === 'merged' ? 'MERGED' : now === 'closed' ? 'CLOSED' : 'OPEN';
        const repository = { pullRequest: asked ? { state } : null };
        return { status: 200, json: { data: { node: { ref }, repository } } };
      }
      if (graphql.includes('updateRefs')) {
        writes.push({ method, pathname, body });
        const { repositoryId: repository, refUpdates } = variables.input as {
          repositoryId: string;
          refUpdates: { name: string }[];
        };
        refUpdates.forEach(({ name }) => deleted.add(`${repository} ${name}`));
        return { status: 200, json: { data: { updateRefs: { clientMutationId: null } } } };
      }
      if (graphql.includes('updatePullRequestBranch')) {
        writes.push({ method, pathname, body });
        const branch = ALL_PULLS.find((candidate) => pullId(candidate) === variables.pullRequestId);
        // The head GitHub's answer names: the one it was sent while the update is still to come.
        let headRefOid = String(variables.expectedHeadOid);
        if (branch && lateUpdate) {
          updating.set(pullPath(branch), { reads: 1, sha: updatedSha(branch) });
        } else if (branch) {
          headRefOid = updatedSha(branch);
          heads.set(pullPath(branch), headRefOid);
          delete behindNow[pullPath(branch)];
        }
        return {
          status: 200,
          json: { data: { updatePullRequestBranch: { pullRequest: { headRefOid } } } },
        };
      }
      const write = `${method} ${pathname}`;
      const [, pull, part] =
        /^(\/repos\/acme\/[^/]+\/pulls\/\d+)(?:\/(merge))?$/.exec(pathname) ?? [];
      const known = (method === 'PUT' && pull && part) || (method === 'PATCH' && pull && !part);
      if (known) {
        writes.push({ method, pathname, body });
        if (write in refuse) return { status: 405, json: { message: refuse[write] } };
        if (part === 'merge') moved.set(pull!, 'merged');
        if (method === 'PATCH') {
          const { state } = body as { state: 'open' | 'closed' };
          moved.set(pull!, state);
        }
        // What GitHub answers; the panel reads only the status.
        return { status: 200, json: part === 'merge' ? { merged: true, message: 'Merged' } : body };
      }
      unanswered.push(write);
      return { status: 404, json: { message: 'Not Found' } };
    }
    const update = updating.get(pathname);
    if (update && update.reads > 0) {
      update.reads -= 1;
    } else if (update) {
      updating.delete(pathname);
      heads.set(pathname, update.sha);
      delete behindNow[pathname];
    }
    const read = gitHubAnswer(pathname, moved, behindNow, heads);
    if (read === undefined) unanswered.push(pathname);
    return read === undefined
      ? { status: 404, json: { message: 'Not Found' } }
      : { status: 200, json: read };
  };
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    const method = request.method();
    if (method === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const { pathname } = new URL(request.url());
    const body: unknown = method === 'GET' ? undefined : request.postDataJSON();
    await route.fulfill({ headers: CORS, ...answer(method, pathname, body) });
  });
  if (mindroom) await stubMindroom(page, mindroom, answer);
  return unanswered;
};

// The room: a team lead, an agent, and threads about their work.

type Thread = {
  topic: string;
  /** The thread's messages after its root, from the lead (`lead`) or the agent (`agent`). */
  replies: ['lead' | 'agent', string][];
  pulls: Pull[];
};

const THREADS = {
  search: {
    topic: 'Search is slow in large workspaces',
    replies: [
      ['agent', 'The query scans every message of the workspace; an index would avoid that.'],
      ['lead', 'Measure it on the staging copy before we add one.'],
    ],
    pulls: [],
  },
  webhooks: {
    topic: 'Webhook deliveries fail silently',
    replies: [
      ['agent', 'The worker drops a delivery after its first timeout. I will add retries.'],
      ['lead', 'Please log each failed attempt too, with the response status.'],
    ],
    pulls: [],
  },
  release: {
    topic: 'Release 2026.11.3',
    replies: [
      ['agent', 'Merged the rate limit per token and the changelog; closed the limit per IP.'],
      ['lead', 'Thanks. I will tag the release after lunch.'],
    ],
    // A merged and a closed pull request show on the card, in their colors.
    pulls: [PULLS.rateLimit, PULLS.ipRateLimit, PULLS.changelog],
  },
  checkout: {
    topic: 'Checkout test fails on CI since Tuesday',
    replies: [
      ['agent', "The fix pins the payment mock's clock. Both e2e jobs still fail on it."],
      ['lead', 'Then it is the runner image again. Can you compare the two jobs?'],
    ],
    pulls: [PULLS.checkoutClock],
  },
  darkMode: {
    topic: 'Dark mode for the settings page',
    replies: [
      ['agent', 'The draft has the colour tokens; the toggle still needs tests.'],
      ['lead', 'Keep it a draft until design signs off on the contrast.'],
    ],
    pulls: [PULLS.darkMode],
  },
  sessions: {
    topic: 'Move session storage from Postgres to Redis',
    replies: [
      ['agent', 'One pull request for the session store and one for the token endpoint.'],
      ['lead', 'I will review the API side first.'],
      ['agent', 'The webapp checks are still running; the API ones passed.'],
    ],
    pulls: [PULLS.sessionStore, PULLS.tokenEndpoint],
  },
} satisfies Record<string, Thread>;

let lead: DisposableUser;
let agent: MatrixSession;
let roomId = '';
/** The root event ID of each thread. */
const roots = {} as Record<keyof typeof THREADS, string>;

const setDisplayName = (session: MatrixSession, displayname: string) =>
  matrixFetch(HOMESERVER, `/profile/${encodeURIComponent(session.userId)}/displayname`, {
    method: 'PUT',
    accessToken: session.accessToken,
    body: JSON.stringify({ displayname }),
  });

let linksWritten = 0;
/** Links (or with `{}` unlinks) `pull` to the thread of `root`, as the backend plugin does. */
const writeLink = (root: string, pull: Pull, content?: Record<string, unknown>) =>
  sendStateEvent(
    HOMESERVER,
    lead.accessToken,
    roomId,
    LINK_EVENT,
    JSON.stringify([root, `acme/${pull.repo}#${pull.number}`]),
    content ?? {
      url: `https://github.com/acme/${pull.repo}/pull/${pull.number}`,
      set_by: agent.userId,
      // A millisecond apart at least, so `set_at` orders the links as they were written.
      set_at: new Date(Date.now() + (linksWritten += 1)).toISOString(),
    }
  );

/** Gives the thread of `root` the worktree `content`, `{}` for none, as the backend plugin does. */
const writeWorktree = (root: string, content: Record<string, unknown>) =>
  sendStateEvent(HOMESERVER, lead.accessToken, roomId, WORKTREE_EVENT, root, content);

test.beforeAll(async () => {
  if (!(await disposableHomeserverIsUp())) return;
  test.setTimeout(3 * 60_000);
  lead = await registerDisposableUser(`prchips_${RUN}`, PASSWORD);
  agent = await registerAgentAccount(HOMESERVER, 'builder');
  await setDisplayName(lead, 'Platform lead');
  await setDisplayName(agent, 'Builder');
  roomId = await createRoom(HOMESERVER, lead.accessToken, {
    name: 'Web platform',
    invite: [agent.userId],
  });
  await joinRoom(HOMESERVER, agent.accessToken, roomId);
  for (const [key, thread] of Object.entries(THREADS) as [keyof typeof THREADS, Thread][]) {
    const root = await sendRoomMessage(HOMESERVER, lead.accessToken, roomId, {
      msgtype: 'm.text',
      body: thread.topic,
    });
    roots[key] = root;
    for (const [who, body] of thread.replies) {
      await sendRoomMessage(HOMESERVER, (who === 'lead' ? lead : agent).accessToken, roomId, {
        msgtype: 'm.text',
        body,
        'm.relates_to': { rel_type: 'm.thread', event_id: root },
      });
    }
    for (const pull of thread.pulls) await writeLink(root, pull);
  }
});

test.beforeEach(async () => {
  test.skip(!(await disposableHomeserverIsUp()), `No homeserver at ${HOMESERVER}`);
});

// The page.

/**
 * Collects the warnings the page prints when one of the SDK's emitters has more than ten listeners
 * for an event, as a room's state would with a listener for each of its cards.
 */
const listenerWarnings = (page: Page): string[] => {
  const warnings: string[] = [];
  page.on('console', (message) => {
    if (message.text().includes('MaxListenersExceededWarning')) warnings.push(message.text());
  });
  return warnings;
};

const STATE_LABEL = { open: 'Open', draft: 'Draft', merged: 'Merged', closed: 'Closed' };
const STATE_TONE = {
  open: 'mrpr-tone-open',
  draft: 'mrpr-tone-draft',
  merged: 'mrpr-tone-merged',
  closed: 'mrpr-tone-closed',
};
const CHECKS_TONE = {
  running: 'mrpr-tone-warning',
  passing: 'mrpr-tone-success',
  failing: 'mrpr-tone-failure',
};

/** A chip's accessible name once GitHub sent its pull request: repository, number, state, title. */
const chipName = (pull: Pull) =>
  `Pull request acme/${pull.repo} #${pull.number}: ${STATE_LABEL[pull.state]}\n${pull.title}`;

const card = (page: Page, root: string) =>
  page.locator(`[data-compact-room-view] [data-thread-root-id="${root}"]`);
const cardChips = (page: Page, root: string) => card(page, root).locator('.mrpr-chip');
const cardMore = (page: Page, root: string) => card(page, root).locator('.mrpr-chip-more');
const strip = (page: Page) => page.getByRole('group', { name: 'Pull requests of this thread' });
const panel = (page: Page) => page.getByRole('region', { name: 'Pull request', exact: true });
const banner = (page: Page) => page.locator('[data-thread-context-banner]');

/**
 * Expects `chips` to be the chips of `pulls`, in order, each with its repository's name, its
 * number, the state GitHub sent and, for an open pull request with checks, the checks' mark. A
 * chip asks GitHub once it has been on screen, so each is scrolled into view first.
 */
const expectChips = async (chips: Locator, pulls: Pull[]) => {
  await expect(chips).toHaveCount(pulls.length);
  for (const [index, pull] of pulls.entries()) {
    const chip = chips.nth(index);
    await chip.scrollIntoViewIfNeeded();
    await expect(chip).toHaveAttribute('aria-label', chipName(pull), { timeout: 30_000 });
    await expect(chip).toHaveText(`${pull.repo}#${pull.number}`);
    await expect(chip.locator(`svg.${STATE_TONE[pull.state]}`)).toHaveCount(1);
    const checks = chip.locator('svg.mrpr-chip-checks');
    if (pull.checks === 'none' || pull.state === 'merged' || pull.state === 'closed') {
      await expect(checks).toHaveCount(0);
    } else {
      await expect(checks).toHaveClass(new RegExp(CHECKS_TONE[pull.checks]), { timeout: 30_000 });
    }
  }
};

/**
 * Signs the lead in, with a GitHub token in the plugin's storage so that the chips ask for checks,
 * and opens the room, whose agent makes it open in the Compact view.
 */
const openRoom = async (page: Page) => {
  await loginWithPassword(page, { homeserver: HOMESERVER, ...lead });
  const tokenKey = `mindroom.plugin:${encodeURIComponent(lead.userId)}/pull-requests/githubToken`;
  await page.evaluate((key) => localStorage.setItem(key, 'ghp_e2e'), tokenKey);
  await page.goto(`/home/${encodeURIComponent(roomId)}`);
  await expect(card(page, roots.sessions)).toBeVisible({ timeout: 120_000 });
};

/** Saves a screenshot; `keepPointer` leaves the pointer where it is, as a hover card needs. */
const shot = async (page: Page, name: string, { keepPointer = false } = {}) => {
  const directory = process.env.MRPR_SHOTS;
  if (!directory) return;
  // A new session's "Catching up..." pill over the room goes with its next sync; no hover or
  // tooltip either, unless the shot is of one.
  await expect(page.getByText(/^Catching up/)).toHaveCount(0, { timeout: 60_000 });
  if (!keepPointer) await page.mouse.move(0, 0);
  await page.screenshot({ path: join(directory, `${name}.png`) });
};

test("each thread's card shows the chips of its pull requests", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  const warnings = listenerWarnings(page);
  await openRoom(page);

  await expectChips(cardChips(page, roots.sessions), THREADS.sessions.pulls);
  await expect(cardMore(page, roots.sessions)).toHaveCount(0);
  await expectChips(cardChips(page, roots.darkMode), THREADS.darkMode.pulls);
  await expectChips(cardChips(page, roots.checkout), THREADS.checkout.pulls);
  // Three pull requests: the first two, then the count of the rest.
  await expectChips(cardChips(page, roots.release), THREADS.release.pulls.slice(0, 2));
  await expect(cardMore(page, roots.release)).toHaveText('+1');
  await expect(cardMore(page, roots.release)).toHaveAttribute('aria-label', '1 more pull request');
  // A thread without a link has no chips at all.
  await expect(card(page, roots.webhooks)).toBeVisible();
  await expect(card(page, roots.webhooks).locator('.mrpr-thread-card-chips')).toHaveCount(0);

  await shot(page, 'compact-light');
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'dark');
  await shot(page, 'compact-dark');
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test('a chip on a card opens the thread and its pull request; the strip switches between them', async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  const [sessionStore, tokenEndpoint] = THREADS.sessions.pulls;
  await expectChips(cardChips(page, roots.sessions), [sessionStore, tokenEndpoint]);

  await cardChips(page, roots.sessions).first().click();
  await expect(banner(page)).toContainText(THREADS.sessions.topic, { timeout: 30_000 });
  await expect(panel(page).locator('.mrpr-panel-title')).toHaveText(sessionStore.title, {
    timeout: 30_000,
  });

  // Under the room header, the thread's pull requests as buttons, the panel's pressed.
  const buttons = strip(page).getByRole('button');
  await expectChips(buttons, [sessionStore, tokenEndpoint]);
  await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'true');
  await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'false');

  await buttons.nth(1).click();
  await expect(panel(page).locator('.mrpr-panel-title')).toHaveText(tokenEndpoint.title);
  await expect(buttons.nth(0)).toHaveAttribute('aria-pressed', 'false');
  await expect(buttons.nth(1)).toHaveAttribute('aria-pressed', 'true');
  await expect(
    panel(page).getByRole('button', { name: 'Open checks: All checks have passed' })
  ).toBeVisible();
  await expect(panel(page).getByText(/^Loading/)).toHaveCount(0);
  await expect(page.getByText(THREADS.sessions.replies[2][1], { exact: true })).toBeVisible();
  await shot(page, 'thread-panel');
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

const hoverCard = (page: Page) => page.getByRole('tooltip');

/**
 * Expects the hover card inside the window and beside `chip`: below a chip in the upper half of
 * the window, above one in the lower half; as tall as its content, which ends where it does (but
 * for its padding); and with its author's login whole.
 */
const expectBeside = async (page: Page, chip: Locator) => {
  const { emptyBelow, loginCut } = await hoverCard(page).evaluate((element) => {
    const last = element.lastElementChild?.getBoundingClientRect().bottom ?? 0;
    const login = element.querySelector('.mrpr-hover-people .mrpr-actor-login');
    return {
      emptyBelow: element.getBoundingClientRect().bottom - last,
      loginCut: login ? login.scrollWidth > login.clientWidth : false,
    };
  });
  expect(emptyBelow).toBeLessThan(16);
  expect(loginCut).toBe(false);
  const card = await hoverCard(page).boundingBox();
  const at = await chip.boundingBox();
  const window = page.viewportSize();
  if (!card || !at || !window) throw new Error('No box for the hover card or its chip');
  expect(card.x).toBeGreaterThanOrEqual(0);
  expect(card.y).toBeGreaterThanOrEqual(0);
  expect(card.x + card.width).toBeLessThanOrEqual(window.width);
  expect(card.y + card.height).toBeLessThanOrEqual(window.height);
  if (at.y + at.height / 2 <= window.height / 2) {
    expect(card.y).toBeGreaterThanOrEqual(at.y + at.height);
  } else {
    expect(card.y + card.height).toBeLessThanOrEqual(at.y);
  }
};

/** Saves the shot `name` in the light theme and in the dark one, and goes back to the light. */
const shotBothThemes = async (page: Page, name: string) => {
  await shot(page, `${name}-light`, { keepPointer: true });
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'dark');
  await shot(page, `${name}-dark`, { keepPointer: true });
  await page.emulateMedia({ colorScheme: 'light' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'light');
};

test("a chip's hover card shows its pull request, on a card and in the strip", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  const [sessionStore, tokenEndpoint] = THREADS.sessions.pulls;
  const chips = cardChips(page, roots.sessions);
  await expectChips(chips, [sessionStore, tokenEndpoint]);

  // On a card: the pull request, its checks and its reviewer's verdict, which it asks for now.
  await chips.nth(1).hover();
  await expect(hoverCard(page)).toContainText(tokenEndpoint.title);
  await expect(hoverCard(page)).toContainText('All checks have passed');
  await expect(hoverCard(page)).toContainText(PULLS.tokenEndpoint.approvedBy);
  await expect(hoverCard(page)).toContainText('Click to open in the side panel');
  await expectBeside(page, chips.nth(1));
  // The card's details card, which waits 500 ms, stays closed while the chip shows its own.
  await page.waitForTimeout(1_000);
  await expect(page.locator('[data-thread-card-details]')).toHaveCount(0);
  await shotBothThemes(page, 'hover-card');
  await page.mouse.move(0, 0);
  await expect(hoverCard(page)).toHaveCount(0);

  // A closed pull request lower in the room: its close, and no checks.
  const [, ipRateLimit] = THREADS.release.pulls;
  const release = cardChips(page, roots.release).nth(1);
  await release.scrollIntoViewIfNeeded();
  await release.hover();
  await expect(hoverCard(page)).toContainText(ipRateLimit.title);
  await expect(hoverCard(page)).toContainText('Closed');
  await expect(hoverCard(page)).toContainText(/closed \d+ hours? ago/);
  await expect(hoverCard(page).locator('.mrpr-hover-checks')).toHaveCount(0);
  await expectBeside(page, release);
  await shot(page, 'hover-card-closed', { keepPointer: true });
  await page.mouse.move(0, 0);

  // In the strip of the open thread, with the reviewer still asked.
  await chips.first().click();
  await expect(banner(page)).toContainText(THREADS.sessions.topic, { timeout: 30_000 });
  const buttons = strip(page).getByRole('button');
  await expectChips(buttons, [sessionStore, tokenEndpoint]);
  await buttons.first().hover();
  await expect(hoverCard(page)).toContainText(sessionStore.title);
  await expect(hoverCard(page).locator('.mrpr-hover-reviews')).toContainText(
    PULLS.sessionStore.reviewers[0]
  );
  // The panel already shows this chip's pull request, so its card offers no click.
  await expect(buttons.first()).toHaveAttribute('aria-pressed', 'true');
  await expect(hoverCard(page).locator('.mrpr-hover-hint')).toHaveCount(0);
  await expectBeside(page, buttons.first());
  await shotBothThemes(page, 'hover-strip');
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test('a hover card as tall as the room by its chip keeps its rows apart', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  await page.setViewportSize({ width: 1280, height: 720 });
  await openRoom(page);
  const chip = cardChips(page, roots.checkout).first();
  await expectChips(cardChips(page, roots.checkout), THREADS.checkout.pulls);
  // Near the window's middle, the card has about half the window's height to fill.
  const at = await chip.boundingBox();
  if (!at) throw new Error('No box for the chip');
  expect(Math.abs(at.y + at.height / 2 - 360)).toBeLessThan(72);

  await chip.hover();
  // The sixth reviewer, whose verdict comes last.
  await expect(hoverCard(page).locator('.mrpr-hover-reviews')).toContainText(
    PULLS.checkoutClock.approvedBy
  );
  // Each row as far as it and its parts reach: a row squeezed below its content's height lets its
  // parts reach over the next row.
  const boxes = await hoverCard(page).evaluate((element) => {
    const box = (selector: string) => {
      const found = selector === 'card' ? element : element.querySelector(selector);
      if (!found) throw new Error(`No ${selector} in the hover card`);
      const parts = [found, ...(selector === 'card' ? [] : found.children)].map((part) =>
        part.getBoundingClientRect()
      );
      return {
        selector,
        top: Math.min(...parts.map((part) => part.top)),
        bottom: Math.max(...parts.map((part) => part.bottom)),
        left: Math.min(...parts.map((part) => part.left)),
        right: Math.max(...parts.map((part) => part.right)),
      };
    };
    return {
      card: box('card'),
      rows: [box('.mrpr-hover-reviews'), box('.mrpr-hover-labels'), box('.mrpr-hover-hint')],
    };
  });
  for (const row of boxes.rows) {
    expect(row.top, `${row.selector} starts inside the card`).toBeGreaterThanOrEqual(
      boxes.card.top
    );
    expect(row.bottom, `${row.selector} ends inside the card`).toBeLessThanOrEqual(
      boxes.card.bottom
    );
    expect(row.left).toBeGreaterThanOrEqual(boxes.card.left);
    expect(row.right).toBeLessThanOrEqual(boxes.card.right);
  }
  for (const [above, below] of [
    [boxes.rows[0], boxes.rows[1]],
    [boxes.rows[1], boxes.rows[2]],
  ]) {
    expect(above.bottom, `${above.selector} ends above ${below.selector}`).toBeLessThanOrEqual(
      below.top
    );
  }
  await expectBeside(page, chip);
  await shot(page, 'hover-card-many-reviewers', { keepPointer: true });
  expect(unanswered).toEqual([]);
});

test('a link written or cleared while the room is open shows on its card at once', async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  const chips = cardChips(page, roots.webhooks);
  await expect(card(page, roots.webhooks)).toBeVisible();
  await expect(chips).toHaveCount(0);
  // Marks this page, so that a reload would show.
  await page.evaluate(() => Object.assign(window, { mrprSamePage: true }));

  await writeLink(roots.webhooks, PULLS.webhookRetries);
  await expectChips(chips, [PULLS.webhookRetries]);

  await writeLink(roots.webhooks, PULLS.webhookRetries, {});
  await expect(chips).toHaveCount(0);
  await expect(card(page, roots.webhooks).locator('.mrpr-thread-card-chips')).toHaveCount(0);
  expect(await page.evaluate(() => 'mrprSamePage' in window)).toBe(true);
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test('on a phone a card shows one chip and the count of the rest', async ({ browser, baseURL }) => {
  test.setTimeout(4 * 60_000);
  const context = await browser.newContext({ baseURL, ...PHONE_CONTEXT });
  const page = await context.newPage();
  try {
    const unanswered = await stubGitHub(page);
    const warnings = listenerWarnings(page);
    await openRoom(page);
    await expectChips(cardChips(page, roots.sessions), [PULLS.sessionStore]);
    await expect(cardMore(page, roots.sessions)).toHaveText('+1');
    await expectChips(cardChips(page, roots.darkMode), [PULLS.darkMode]);
    await expect(cardMore(page, roots.darkMode)).toHaveCount(0);
    await expectChips(cardChips(page, roots.checkout), [PULLS.checkoutClock]);
    await expectChips(cardChips(page, roots.release), [PULLS.rateLimit]);
    await expect(cardMore(page, roots.release)).toHaveText('+2');
    await expect(cardMore(page, roots.release)).toHaveAttribute(
      'aria-label',
      '2 more pull requests'
    );
    await shot(page, 'phone-compact');

    // A long repository name before a long branch leaves the branch chip as wide as it is without
    // one, and the card's reply count inside the card.
    const worktree = {
      path: '/srv/worktrees/billing-webhook-retries',
      branch: 'webhook-retries-with-exponential-backoff',
      set_by: agent.userId,
      set_at: new Date().toISOString(),
    };
    const branch = card(page, roots.webhooks).locator('.mrpr-branch-chip');
    await writeWorktree(roots.webhooks, worktree);
    await expect(branch).toBeVisible({ timeout: 30_000 });
    const plain = (await branch.boundingBox())?.width ?? 0;
    await writeWorktree(roots.webhooks, { ...worktree, repo: 'billing-and-invoicing-service' });
    await expect(branch.locator('.mrpr-chip-repo')).toBeVisible({ timeout: 30_000 });
    const withRepository = (await branch.boundingBox())?.width ?? 0;
    expect(plain).toBeGreaterThan(0);
    expect(withRepository).toBeLessThanOrEqual(plain + 1);
    const box = await card(page, roots.webhooks).boundingBox();
    const replies = await card(page, roots.webhooks)
      .locator('[data-compact-card-reply-count]')
      .boundingBox();
    expect(replies && box && replies.x + replies.width <= box.x + box.width).toBe(true);
    await shot(page, 'phone-branch-repo');
    await writeWorktree(roots.webhooks, {});
    await expect(branch).toHaveCount(0);
    expect(unanswered).toEqual([]);
    expect(warnings).toEqual([]);
  } finally {
    await context.close();
  }
});

/** Whether `locator`'s text shows whole, not cut at its element's end. */
const shownWhole = (locator: Locator) =>
  locator.evaluate((element) => element.scrollWidth <= element.clientWidth);

/** Expects `details` to show the pull requests `pulls` in order, each by its title from GitHub. */
const expectDetailsTitles = async (details: Locator, pulls: Pull[]) => {
  const blocks = details.locator('.mrpr-details-pull-request');
  await expect(blocks).toHaveCount(pulls.length);
  await expect(blocks.locator('.mrpr-details-title')).toHaveText(
    pulls.map((pull) => pull.title),
    { timeout: 30_000 }
  );
};

test("resting the pointer on a card shows all its pull requests' details", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  const details = page.locator('[data-thread-card-details]');
  const [rateLimit] = THREADS.release.pulls;
  const blocks = details.locator('.mrpr-details-pull-request');

  // All three pull requests, also the one the card's chips leave to their count.
  await card(page, roots.release).hover();
  await expectDetailsTitles(details, THREADS.release.pulls);
  await expect(
    blocks.first().getByText(`${rateLimit.branch} → main`, { exact: true })
  ).toBeVisible();
  // Its size and its author's whole login, which the line wraps for rather than cut.
  const meta = blocks.first().locator('.mrpr-meta');
  await expect(meta).toContainText('+268');
  await expect(meta).toContainText('9 files');
  const author = meta.getByText('@acme-builder', { exact: true });
  await expect(author).toBeVisible();
  expect(await shownWhole(author)).toBe(true);
  // Two long branches, each shortened in its middle, on a line that wraps so both their ends show.
  const branches = blocks
    .nth(THREADS.release.pulls.indexOf(PULLS.ipRateLimit))
    .getByText('rate-limit-p…-ip-address → release/2026…i-hardening', { exact: true });
  await expect(branches).toBeVisible();
  expect(await shownWhole(branches)).toBe(true);
  await shot(page, 'details-light', { keepPointer: true });

  await page.mouse.move(0, 0);
  await expect(details).toHaveCount(0);
  await page.emulateMedia({ colorScheme: 'dark' });
  await expect(page.locator('html')).toHaveAttribute('data-theme-kind', 'dark');
  await card(page, roots.release).hover();
  await expectDetailsTitles(details, THREADS.release.pulls);
  await shot(page, 'details-dark', { keepPointer: true });
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test('on a phone a long press on a card opens its menu with the details', async ({
  browser,
  baseURL,
}) => {
  test.setTimeout(4 * 60_000);
  const context = await browser.newContext({ baseURL, ...PHONE_CONTEXT });
  const page = await context.newPage();
  try {
    const unanswered = await stubGitHub(page);
    const warnings = listenerWarnings(page);
    await openRoom(page);
    await touch(card(page, roots.sessions), [
      { type: 'start' },
      { type: 'wait', ms: 700 },
      { type: 'end' },
    ]);
    const details = page.getByRole('menu').locator('[data-thread-details]');
    await expectDetailsTitles(details, [PULLS.sessionStore, PULLS.tokenEndpoint]);
    await shot(page, 'phone-details-menu', { keepPointer: true });
    expect(unanswered).toEqual([]);
    expect(warnings).toEqual([]);
  } finally {
    await context.close();
  }
});

type SyncGate = {
  /** Holds the page's /sync requests back until the release; one already open goes on. */
  hold(): void;
  /** Lets the held requests reach the server, each with the token it was sent with. */
  release(): void;
  /** Whether an answer after the release said the room's timeline was limited. */
  sawLimited(): boolean;
};

/** The page's /sync, which the test can hold back to make a gap, as a laptop's sleep does. */
const gateSync = async (page: Page): Promise<SyncGate> => {
  let held: Promise<void> | undefined;
  let release = () => undefined as void;
  let released = false;
  let limited = false;
  await page.route(
    (url) => url.pathname.endsWith('/_matrix/client/v3/sync'),
    async (route) => {
      try {
        await held;
        // A long poll takes up to the server's own 30 seconds.
        const response = await route.fetch({ timeout: 0 });
        const body = (await response.json()) as {
          rooms?: { join?: Record<string, { timeline?: { limited?: boolean } }> };
        };
        if (released && body.rooms?.join?.[roomId]?.timeline?.limited) limited = true;
        await route.fulfill({ response });
      } catch {
        // The page closed, or gave the request up, while it was open.
      }
    }
  );
  return {
    hold: () => {
      held = new Promise<void>((resolve) => {
        release = () => {
          held = undefined;
          released = true;
          resolve();
        };
      });
    },
    release: () => release(),
    sawLimited: () => limited,
  };
};

const GAP_STEPS = 40;

test("a link written after a gap in the room's sync still shows on its card", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  const warnings = listenerWarnings(page);
  const sync = await gateSync(page);
  await openRoom(page);
  const chips = cardChips(page, roots.webhooks);
  await expect(card(page, roots.webhooks)).toBeVisible();
  await expect(chips).toHaveCount(0);
  const deployLog = await sendRoomMessage(HOMESERVER, agent.accessToken, roomId, {
    msgtype: 'm.text',
    body: 'Nightly deploy to staging',
  });
  await expect(card(page, deployLog)).toBeVisible({ timeout: 30_000 });

  // The page falls behind by more than a sync answer carries (20 events a room), as after a
  // laptop's sleep: its next answer is limited, and the SDK resets the room's live timeline. The
  // reset keeps the room's `currentState` object (`EventTimeline.forkLive`), so the links' listener
  // on it must keep hearing new links. The long poll open at the hold takes a step or two at most.
  sync.hold();
  for (let step = 1; step <= GAP_STEPS; step += 1) {
    await sendRoomMessage(HOMESERVER, agent.accessToken, roomId, {
      msgtype: 'm.text',
      body: `Deploy step ${step} of ${GAP_STEPS} done.`,
      'm.relates_to': { rel_type: 'm.thread', event_id: deployLog },
    });
  }
  sync.release();
  await expect
    .poll(() => sync.sawLimited(), { timeout: 60_000, message: 'a limited sync' })
    .toBe(true);
  await expect(card(page, deployLog)).toContainText(`Deploy step ${GAP_STEPS} of ${GAP_STEPS}`, {
    timeout: 30_000,
  });

  await writeLink(roots.webhooks, PULLS.webhookRetries);
  await expectChips(chips, [PULLS.webhookRetries]);
  await writeLink(roots.webhooks, PULLS.webhookRetries, {});
  await expect(chips).toHaveCount(0);
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a thread's worktree shows as its branch on its card and in the strip until it is cleared", async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const unanswered = await stubGitHub(page);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  const worktree = {
    path: 'worktrees/webhook-retries',
    branch: 'webhook-retries',
    set_by: agent.userId,
    set_at: new Date().toISOString(),
  };
  const label = 'Worktree worktrees/webhook-retries, branch webhook-retries';
  const branch = card(page, roots.webhooks).locator('.mrpr-branch-chip');
  await expect(card(page, roots.webhooks)).toBeVisible();
  await expect(branch).toHaveCount(0);
  // Marks this page, so that a reload would show.
  await page.evaluate(() => Object.assign(window, { mrprSamePage: true }));

  // A thread without links shows its branch on its card, in the place of the chips.
  await writeWorktree(roots.webhooks, worktree);
  await expect(branch).toHaveText(worktree.branch, { timeout: 30_000 });
  await expect(branch).toHaveAttribute('aria-label', label);
  await expect(card(page, roots.webhooks).locator('.mrpr-thread-card-chips')).toHaveCount(0);
  await shot(page, 'branch-card');

  // A worktree outside the workspace, by its absolute path, with its repository's name before
  // the branch's.
  const outside = '/srv/billing-worktrees/webhook-retries';
  await writeWorktree(roots.webhooks, { ...worktree, path: outside, repo: 'billing' });
  await expect(branch.locator('.mrpr-chip-repo')).toHaveText('billing', { timeout: 30_000 });
  await expect(branch.locator('.mrpr-branch-chip-name')).toHaveText(worktree.branch);
  await expect(branch).toHaveAttribute(
    'aria-label',
    `Worktree ${outside}, repository billing, branch webhook-retries`
  );
  await shot(page, 'branch-card-repo');
  await writeWorktree(roots.webhooks, {});
  await expect(branch).toHaveCount(0);

  // A click on the branch opens the thread, as anywhere else on the card; the strip under the room
  // header shows the branch alone, as text.
  await writeWorktree(roots.webhooks, { ...worktree, set_at: new Date().toISOString() });
  await branch.click();
  await expect(banner(page)).toContainText(THREADS.webhooks.topic, { timeout: 30_000 });
  const stripBranch = strip(page).locator('.mrpr-branch-chip');
  await expect(stripBranch).toHaveText(worktree.branch);
  await expect(stripBranch).toHaveAttribute('aria-label', label);
  await expect(strip(page).getByRole('button')).toHaveCount(0);
  await expect(page.getByText(THREADS.webhooks.replies[1][1], { exact: true })).toBeVisible();
  await shot(page, 'branch-strip');

  await writeWorktree(roots.webhooks, {});
  await expect(strip(page)).toHaveCount(0);
  expect(await page.evaluate(() => 'mrprSamePage' in window)).toBe(true);
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a viewer who can write merges the panel's pull request with two clicks", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const writes: Write[] = [];
  const unanswered = await stubGitHub(page, writes);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  const { tokenEndpoint } = PULLS;
  await expectChips(cardChips(page, roots.sessions), THREADS.sessions.pulls);
  await cardChips(page, roots.sessions).nth(1).click();
  await expect(panel(page).locator('.mrpr-panel-title')).toHaveText(tokenEndpoint.title, {
    timeout: 30_000,
  });
  const merge = panel(page).getByRole('button', { name: 'Merge', exact: true });
  await expect(merge).toBeVisible({ timeout: 30_000 });
  await expect(
    panel(page).getByRole('button', { name: 'Open checks: All checks have passed' })
  ).toBeVisible();
  await expect(panel(page).getByText(/^Loading/)).toHaveCount(0);
  await shot(page, 'actions-open');

  // The menu: the merge methods, the first chosen, then Close and Refresh.
  await panel(page).getByRole('button', { name: 'More actions' }).click();
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(menu.getByRole('menuitemradio')).toHaveText([
    'Merge',
    'Squash and merge',
    'Rebase and merge',
  ]);
  await expect(menu.getByRole('menuitemradio', { name: 'Merge', exact: true })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await shot(page, 'actions-menu', { keepPointer: true });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // The first click arms the button, which goes back after 3 s without a second.
  await merge.click();
  const confirm = panel(page).getByRole('button', { name: 'Confirm merge?' });
  await expect(confirm).toBeVisible();
  await shot(page, 'actions-confirm', { keepPointer: true });
  await expect(merge).toBeVisible({ timeout: 10_000 });
  expect(writes).toEqual([]);

  // Two clicks merge, with the head the panel shows, and the refetch shows it merged.
  await merge.click();
  await confirm.click();
  await expect(panel(page).locator('.mrpr-badge-state')).toHaveText('Merged', { timeout: 30_000 });
  expect(writes).toEqual([
    {
      method: 'PUT',
      pathname: `/repos/acme/${tokenEndpoint.repo}/pulls/${tokenEndpoint.number}/merge`,
      body: { merge_method: 'merge', sha: headSha(tokenEndpoint) },
    },
  ]);
  await expect(merge).toHaveCount(0);
  // A screen reader heard the merge, which the line does not show; and the focus, which the
  // button that is gone had, is on More actions, not lost to the page.
  const status = panel(page).getByRole('status');
  await expect(status).toHaveText('Pull request merged');
  await expect(status).toHaveClass('mrpr-sr-only');
  await expect(panel(page).getByRole('button', { name: 'More actions' })).toBeFocused();
  await shot(page, 'actions-merged');

  // The merged pull request's branch goes only after the dialog's own button; Cancel sends nothing.
  await panel(page).getByRole('button', { name: 'More actions' }).click();
  await menu.getByRole('menuitem', { name: 'Delete branch' }).click();
  const dialog = page.getByRole('dialog', { name: `Delete branch ${tokenEndpoint.branch}?` });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText(
    `This deletes ${tokenEndpoint.branch} from acme/${tokenEndpoint.repo} on GitHub.`
  );
  await shot(page, 'actions-delete-dialog');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(writes.map(({ method }) => method)).toEqual(['PUT']);

  // The dialog's own button deletes the branch, only where the pull request left it, and the
  // menu offers the branch no more once it is gone.
  await panel(page).getByRole('button', { name: 'More actions' }).click();
  await menu.getByRole('menuitem', { name: 'Delete branch' }).click();
  await dialog.getByRole('button', { name: 'Delete branch' }).click();
  await expect(panel(page).getByText('Branch deleted')).toBeVisible({ timeout: 30_000 });
  expect(writes.slice(1).map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([
    'POST /graphql',
  ]);
  expect((writes[1].body as { variables: unknown }).variables).toEqual({
    input: {
      repositoryId: repositoryId(tokenEndpoint),
      refUpdates: [
        {
          name: `refs/heads/${tokenEndpoint.branch}`,
          beforeOid: headSha(tokenEndpoint),
          afterOid: '0'.repeat(40),
        },
      ],
    },
  });
  await panel(page).getByRole('button', { name: 'More actions' }).click();
  await expect(menu.getByRole('menuitem', { name: 'Refresh' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Delete branch' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

/** Opens the side panel on the token endpoint's pull request, from its chip on the thread's card. */
const openTokenEndpoint = async (page: Page) => {
  const { tokenEndpoint } = PULLS;
  await expectChips(cardChips(page, roots.sessions), THREADS.sessions.pulls);
  await cardChips(page, roots.sessions).nth(1).click();
  await expect(panel(page).locator('.mrpr-panel-title')).toHaveText(tokenEndpoint.title, {
    timeout: 30_000,
  });
  await expect(panel(page).getByRole('button', { name: 'More actions' })).toBeVisible({
    timeout: 30_000,
  });
};

test("a merge GitHub refuses shows GitHub's reason under the header", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const { tokenEndpoint } = PULLS;
  const path = `/repos/acme/${tokenEndpoint.repo}/pulls/${tokenEndpoint.number}/merge`;
  const reason = 'Head branch was modified. Review and try the merge again.';
  const writes: Write[] = [];
  const unanswered = await stubGitHub(page, writes, { refuse: { [`PUT ${path}`]: reason } });
  const warnings = listenerWarnings(page);
  await openRoom(page);
  await openTokenEndpoint(page);
  const merge = panel(page).getByRole('button', { name: 'Merge', exact: true });
  await merge.click();
  await panel(page).getByRole('button', { name: 'Confirm merge?' }).click();
  const result = panel(page).locator('.mrpr-action-result');
  await expect(result).toContainText(reason, { timeout: 30_000 });
  await expect(result).toContainText('Could not merge this pull request');
  await expect(result).toHaveAttribute('role', 'status');
  await shot(page, 'actions-refused');
  expect(writes.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual([`PUT ${path}`]);
  // Still open, so Merge is offered again, with the focus it kept while the merge ran, and the
  // line goes with its Dismiss.
  await expect(merge).toBeEnabled();
  await expect(merge).toBeFocused();
  await result.getByRole('button', { name: 'Dismiss' }).click();
  await expect(result).toHaveCount(0);
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test('the merge method chosen in the menu names Merge, and holds for the next pull request and the next page load', async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const writes: Write[] = [];
  const unanswered = await stubGitHub(page, writes);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  await openTokenEndpoint(page);
  const more = panel(page).getByRole('button', { name: 'More actions' });
  const menu = page.getByRole('menu', { name: 'More actions' });
  await expect(panel(page).getByRole('button', { name: 'Merge', exact: true })).toBeVisible();
  await more.click();
  await menu.getByRole('menuitemradio', { name: 'Squash and merge' }).click();
  await expect(menu).toHaveCount(0);
  const squash = panel(page).getByRole('button', { name: 'Squash and merge', exact: true });
  await expect(squash).toBeVisible();
  await more.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Squash and merge' })).toHaveAttribute(
    'aria-checked',
    'true'
  );
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);

  // The thread's other pull request, whose checks still run, auto-merges with it.
  await strip(page).getByRole('button').nth(0).click();
  await expect(panel(page).locator('.mrpr-panel-title')).toHaveText(PULLS.sessionStore.title);
  await expect(panel(page).getByRole('button', { name: 'Auto-merge (squash)' })).toBeVisible({
    timeout: 30_000,
  });

  // And after the page loads again.
  await page.goto(`/home/${encodeURIComponent(roomId)}`);
  await expect(card(page, roots.sessions)).toBeVisible({ timeout: 120_000 });
  await openTokenEndpoint(page);
  await expect(squash).toBeVisible();
  expect(writes).toEqual([]);
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test('a pull request closed with two clicks reopens from the menu', async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const { tokenEndpoint } = PULLS;
  const writes: Write[] = [];
  const unanswered = await stubGitHub(page, writes);
  const warnings = listenerWarnings(page);
  await openRoom(page);
  await openTokenEndpoint(page);
  const more = panel(page).getByRole('button', { name: 'More actions' });
  const menu = page.getByRole('menu', { name: 'More actions' });
  const badge = panel(page).locator('.mrpr-badge-state');
  const merge = panel(page).getByRole('button', { name: 'Merge', exact: true });
  const pull = `/repos/acme/${tokenEndpoint.repo}/pulls/${tokenEndpoint.number}`;

  await more.click();
  await menu.getByRole('menuitem', { name: 'Close pull request' }).click();
  expect(writes).toEqual([]);
  await menu.getByRole('menuitem', { name: 'Confirm close?' }).click();
  await expect(badge).toHaveText('Closed', { timeout: 30_000 });
  await expect(merge).toHaveCount(0);
  expect(writes).toEqual([{ method: 'PATCH', pathname: pull, body: { state: 'closed' } }]);
  await shot(page, 'actions-closed');

  await more.click();
  await menu.getByRole('menuitem', { name: 'Reopen pull request' }).click();
  // The menu's button has the focus back at once, while the action still runs.
  await expect(more).toBeFocused();
  await expect(badge).toHaveCount(0, { timeout: 30_000 });
  await expect(more).toBeFocused();
  await expect(merge).toBeVisible();
  expect(writes).toEqual([
    { method: 'PATCH', pathname: pull, body: { state: 'closed' } },
    { method: 'PATCH', pathname: pull, body: { state: 'open' } },
  ]);
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test("a branch behind its base updates from the base branch's warning", async ({ page }) => {
  test.setTimeout(4 * 60_000);
  const { tokenEndpoint } = PULLS;
  const pull = `/repos/acme/${tokenEndpoint.repo}/pulls/${tokenEndpoint.number}`;
  const writes: Write[] = [];
  const unanswered = await stubGitHub(page, writes, { behind: { [pull]: 2 } });
  const warnings = listenerWarnings(page);
  await openRoom(page);
  await openTokenEndpoint(page);
  const warning = panel(page).getByRole('button', { name: 'Warnings for main' });
  await warning.click();
  await expect(page.getByText(`${tokenEndpoint.branch} is 2 commits behind main`)).toBeVisible();
  await shot(page, 'actions-behind', { keepPointer: true });
  await page.getByRole('button', { name: 'Update branch', exact: true }).click();
  // GitHub's answer names the new head, so the branch is updated.
  await expect(panel(page).getByText('Branch updated')).toBeVisible({ timeout: 30_000 });
  expect(writes.map(({ method, pathname }) => `${method} ${pathname}`)).toEqual(['POST /graphql']);
  expect((writes[0].body as { variables: unknown }).variables).toEqual({
    pullRequestId: pullId(tokenEndpoint),
    expectedHeadOid: headSha(tokenEndpoint),
    updateMethod: 'MERGE',
  });
  // The panel has the new head: the branch is up to date.
  await expect(warning).toHaveCount(0, { timeout: 30_000 });
  await shot(page, 'actions-updated');

  // And a merge sends that new head, not the old one, which GitHub would refuse.
  await panel(page).getByRole('button', { name: 'Merge', exact: true }).click();
  await panel(page).getByRole('button', { name: 'Confirm merge?' }).click();
  await expect(panel(page).locator('.mrpr-badge-state')).toHaveText('Merged', { timeout: 30_000 });
  expect(writes[1]).toEqual({
    method: 'PUT',
    pathname: `${pull}/merge`,
    body: { merge_method: 'merge', sha: updatedSha(tokenEndpoint) },
  });
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test('an update GitHub has not made yet is only requested, and Refresh shows it once made', async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const { tokenEndpoint } = PULLS;
  const pull = `/repos/acme/${tokenEndpoint.repo}/pulls/${tokenEndpoint.number}`;
  const writes: Write[] = [];
  const unanswered = await stubGitHub(page, writes, { behind: { [pull]: 2 }, lateUpdate: true });
  const warnings = listenerWarnings(page);
  await openRoom(page);
  await openTokenEndpoint(page);
  const warning = panel(page).getByRole('button', { name: 'Warnings for main' });
  await warning.click();
  await page.getByRole('button', { name: 'Update with rebase', exact: true }).click();
  // GitHub's answer names the head the panel has, and the read after it still has that head:
  // the line does not claim the branch is rebased, and the branch still shows as behind.
  const result = panel(page).locator('.mrpr-action-result');
  await expect(result).toHaveText('Branch rebase requested', { timeout: 30_000 });
  await expect(panel(page).getByText('Branch rebased')).toHaveCount(0);
  expect((writes[0].body as { variables: unknown }).variables).toEqual({
    pullRequestId: pullId(tokenEndpoint),
    expectedHeadOid: headSha(tokenEndpoint),
    updateMethod: 'REBASE',
  });
  await expect(warning).toBeVisible();
  await shot(page, 'actions-update-requested', { keepPointer: true });
  await page.keyboard.press('Escape');

  // GitHub has made the commit by the next read, which Refresh asks for.
  await panel(page).getByRole('button', { name: 'More actions' }).click();
  await page
    .getByRole('menu', { name: 'More actions' })
    .getByRole('menuitem', { name: 'Refresh' })
    .click();
  await expect(warning).toHaveCount(0, { timeout: 30_000 });
  expect(writes).toHaveLength(1);
  expect(unanswered).toEqual([]);
  expect(warnings).toEqual([]);
});

test("on a phone the panel's header has the controls", async ({ browser, baseURL }) => {
  test.setTimeout(4 * 60_000);
  const context = await browser.newContext({ baseURL, ...PHONE_CONTEXT });
  const page = await context.newPage();
  try {
    const unanswered = await stubGitHub(page);
    const warnings = listenerWarnings(page);
    await openRoom(page);
    await expectChips(cardChips(page, roots.sessions), [PULLS.sessionStore]);
    await cardChips(page, roots.sessions).first().click();
    await expect(panel(page).locator('.mrpr-panel-title')).toHaveText(PULLS.sessionStore.title, {
      timeout: 30_000,
    });
    await expect(panel(page).getByRole('button', { name: 'Auto-merge (merge)' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(panel(page).getByRole('button', { name: 'More actions' })).toBeVisible();
    await expect(panel(page).getByText(/^Loading/)).toHaveCount(0);
    await shot(page, 'actions-phone');
    expect(unanswered).toEqual([]);
    expect(warnings).toEqual([]);
  } finally {
    await context.close();
  }
});

test("without a token, the GitHub account connected in MindRoom reads and merges through the room's MindRoom server", async ({
  page,
}) => {
  test.setTimeout(4 * 60_000);
  const writes: Write[] = [];
  const unanswered = await stubGitHub(page, writes, { mindroom: MINDROOM });
  const fromPage: string[] = [];
  page.on('request', (request) => {
    if (request.url().startsWith('https://api.github.com/')) fromPage.push(request.url());
  });
  // The deployment's MindRoom server, which the room has as it has a MindRoom agent.
  await page.route('**/config.json', async (route) => {
    const config = await (await route.fetch()).json();
    const mindroom = { ...config.mindroom, computers: { apiUrl: MINDROOM } };
    await route.fulfill({ json: { ...config, mindroom } });
  });
  await loginWithPassword(page, { homeserver: HOMESERVER, ...lead });
  await page.goto(`/home/${encodeURIComponent(roomId)}`);
  await expect(card(page, roots.sessions)).toBeVisible({ timeout: 120_000 });

  // The chips have their checks' marks, which need an account.
  const { tokenEndpoint } = PULLS;
  await expectChips(cardChips(page, roots.sessions), THREADS.sessions.pulls);
  await cardChips(page, roots.sessions).nth(1).click();
  await expect(panel(page).locator('.mrpr-panel-title')).toHaveText(tokenEndpoint.title, {
    timeout: 30_000,
  });
  await expect(
    panel(page).getByText(`Using your GitHub account connected in MindRoom (@${CONNECTED_LOGIN}).`)
  ).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'Forget token' })).toHaveCount(0);
  const merge = panel(page).getByRole('button', { name: 'Merge', exact: true });
  await expect(merge).toBeVisible({ timeout: 30_000 });
  await expect(panel(page).getByText(/^Loading/)).toHaveCount(0);
  await shot(page, 'mindroom-connected');

  await merge.click();
  await panel(page).getByRole('button', { name: 'Confirm merge?' }).click();
  await expect(panel(page).locator('.mrpr-badge-state')).toHaveText('Merged', { timeout: 30_000 });
  expect(writes).toEqual([
    {
      method: 'PUT',
      pathname: `/repos/acme/${tokenEndpoint.repo}/pulls/${tokenEndpoint.number}/merge`,
      body: { merge_method: 'merge', sha: headSha(tokenEndpoint) },
    },
  ]);
  // Every request went through MindRoom: the page itself asked GitHub nothing.
  expect(fromPage).toEqual([]);
  expect(unanswered).toEqual([]);
});
