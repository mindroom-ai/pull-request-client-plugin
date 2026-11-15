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

// A thread's pull requests in a production build with this plugin, against the disposable
// homeserver, with GitHub's API answered by the page (no request leaves the test). The links are
// the room state events MindRoom's backend plugin writes; here the room's creator writes them. A
// thread's card in the Compact view shows a chip per pull request, two at most (one on a phone) and
// the count of the rest; a click on a chip opens the thread and the pull request in the side
// panel; the strip under the room header has the thread's chips as buttons, the panel's pressed;
// a link written or cleared while the room is open shows on its card at once, also after a gap in
// the room's sync; and the room's six threads leave the SDK's emitters within their listener limit.
// Set MRPR_SHOTS=<directory> to save the screenshots of the pull request.

const LINK_EVENT = 'com.mindroom.thread.pull_request';
const PASSWORD = 'thread-pull-requests-password';
const RUN = Date.now().toString(36);
const DESKTOP = { width: 1280, height: 800 };
const PHONE = { width: 390, height: 844 };

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
  author: string;
  body: string;
  labels?: string[];
  approvedBy?: string;
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
    author: 'acme-builder',
    body: 'Moves the session store from Postgres to Redis behind the `SessionStore` interface.',
    labels: ['backend', 'performance'],
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
    author: 'acme-builder',
    body: 'The checkout test read the wall clock, so a slow runner saw an expired card.',
    labels: ['tests'],
  },
  rateLimit: {
    repo: 'api',
    number: 79,
    title: 'Rate limit the public API per token',
    state: 'merged',
    checks: 'passing',
    branch: 'rate-limit-per-token',
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
    author: 'platform-lead',
    body: 'Release notes for 2026.11.3.',
  },
  ipRateLimit: {
    repo: 'api',
    number: 83,
    title: 'Rate limit the public API per IP address',
    state: 'closed',
    checks: 'none',
    branch: 'rate-limit-per-ip',
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
    author: 'acme-builder',
    body: 'Retries a failed delivery five times with exponential backoff and logs each attempt.',
    labels: ['backend'],
  },
} satisfies Record<string, Pull>;
const ALL_PULLS: Pull[] = Object.values(PULLS);

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const headSha = (pull: Pull) =>
  `${pull.repo === 'api' ? 'a' : 'b'}${String(pull.number).padStart(39, '0')}`;
const gitHubUser = (login: string) => ({
  login,
  avatar_url: null,
  html_url: `https://github.com/${login}`,
  type: 'User',
});

const apiPull = (pull: Pull) => {
  const repo = { full_name: `acme/${pull.repo}` };
  const done = pull.state === 'merged' || pull.state === 'closed';
  return {
    number: pull.number,
    title: pull.title,
    state: done ? 'closed' : 'open',
    draft: pull.state === 'draft',
    body: pull.body,
    user: gitHubUser(pull.author),
    labels: (pull.labels ?? []).map((name) => ({ name, color: '0e8a16' })),
    requested_reviewers: [],
    requested_teams: [],
    mergeable_state: done ? null : 'clean',
    auto_merge: null,
    head: { sha: headSha(pull), ref: pull.branch, repo },
    base: { ref: 'main', repo },
    merged_at: pull.state === 'merged' ? ago(95) : null,
    closed_at: done ? ago(95) : null,
    comments: pull.comment ? 1 : 0,
    review_comments: 0,
    commits: 3,
    created_at: ago(26 * 60),
    updated_at: ago(42),
    additions: 184,
    deletions: 37,
    changed_files: 7,
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

/** GitHub's answer to a GET of `pathname`, or undefined for a path these pull requests lack. */
const gitHubAnswer = (pathname: string): unknown => {
  const [, repo, kind, id, part] =
    /^\/repos\/acme\/([^/]+)\/([a-z]+)\/([^/]+)(?:\/([a-z-]+))?$/.exec(pathname) ?? [];
  if (kind === 'compare') return { behind_by: 0, ahead_by: 3 };
  if (kind === 'commits') {
    const pull = ALL_PULLS.find(
      (candidate) => candidate.repo === repo && headSha(candidate) === id
    );
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
  if (kind === 'pulls' && part === undefined) return apiPull(pull);
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
  'access-control-allow-headers': 'accept, authorization, x-github-api-version',
  'access-control-allow-methods': 'GET',
};

/** Answers GitHub's API in the page; the returned list collects the paths it had no answer for. */
const stubGitHub = async (page: Page): Promise<string[]> => {
  const unanswered: string[] = [];
  await page.route('https://api.github.com/**', async (route) => {
    const request = route.request();
    if (request.method() === 'OPTIONS') {
      await route.fulfill({ status: 204, headers: CORS });
      return;
    }
    const { pathname } = new URL(request.url());
    const answer = gitHubAnswer(pathname);
    if (answer === undefined) unanswered.push(pathname);
    await route.fulfill(
      answer === undefined
        ? { status: 404, headers: CORS, json: { message: 'Not Found' } }
        : { headers: CORS, json: answer }
    );
  });
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
    pulls: [PULLS.rateLimit, PULLS.changelog, PULLS.ipRateLimit],
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
    const text = message.text();
    if (/MaxListenersExceededWarning|Possible EventEmitter memory leak/.test(text)) {
      warnings.push(text);
    }
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

const shot = async (page: Page, name: string) => {
  const directory = process.env.MRPR_SHOTS;
  if (!directory) return;
  // A new session's "Catching up..." pill over the room goes with its next sync; no hover or
  // tooltip either.
  await expect(page.getByText(/^Catching up/)).toHaveCount(0, { timeout: 60_000 });
  await page.mouse.move(0, 0);
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
  const context = await browser.newContext({
    baseURL,
    viewport: PHONE,
    deviceScaleFactor: 2,
    hasTouch: true,
    isMobile: true,
    serviceWorkers: 'block',
  });
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
