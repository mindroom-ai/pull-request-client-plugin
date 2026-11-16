// @vitest-environment jsdom
import type { ComponentProps } from 'react';
import { focusManager, QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from './index';
import { PullRequestChip } from './PullRequestChip';

const REF = { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 412 };
const SHA = 'abc123';
const LABEL = 'Pull request mindroom-ai/mindroom-chat #412';

const pull = (over: Record<string, unknown> = {}) => ({
  title: 'Add pull request chips',
  state: 'open',
  draft: false,
  merged_at: null,
  head: { sha: SHA },
  ...over,
});

const MERGED = { state: 'closed', merged_at: '2026-11-01T00:00:00Z' };

const run = (conclusion: string | null, status = 'completed') => ({
  name: `build ${conclusion ?? status}`,
  status,
  conclusion,
});

const respond = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();

const requested = (part: string) => fetchMock.mock.calls.some(([url]) => url.includes(part));

// Where `usePluginStorage` keeps the GitHub token of the test's account.
const TOKEN_KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/githubToken';
const saveToken = () => localStorage.setItem(TOKEN_KEY, 'ghp_test');

/** The chips' observers, which report only when a test tells them to (`report`). */
const observers: FakeIntersectionObserver[] = [];
class FakeIntersectionObserver {
  readonly targets = new Set<Element>();
  readonly callback: IntersectionObserverCallback;
  constructor(callback: IntersectionObserverCallback) {
    this.callback = callback;
    observers.push(this);
  }
  observe(target: Element) {
    this.targets.add(target);
  }
  unobserve(target: Element) {
    this.targets.delete(target);
  }
  disconnect() {
    this.targets.clear();
  }
}

/** Reports to each observer that its elements are on screen, or not. */
const report = (isIntersecting: boolean) => {
  for (const observer of observers) {
    const entries = [...observer.targets].map(
      (target) => ({ target, isIntersecting } as IntersectionObserverEntry)
    );
    if (entries.length > 0) {
      observer.callback(entries, observer as unknown as IntersectionObserver);
    }
  }
};

/**
 * GitHub with the pull request `pr`, whose head commit has the check runs `runs`, and its reviews
 * `reviews`.
 */
const serve = (pr: unknown, runs: unknown[] = [], reviews: unknown[] = []) =>
  fetchMock.mockImplementation(async (url) => {
    if (url.endsWith('/repos/mindroom-ai/mindroom-chat/pulls/412')) return respond(pr);
    if (url.includes('/pulls/412/reviews?')) return respond(reviews);
    if (url.includes(`/commits/${SHA}/check-runs?`)) return respond({ check_runs: runs });
    if (url.includes(`/commits/${SHA}/status?`)) return respond({ statuses: [] });
    return respond({ message: 'Not Found' }, 404);
  });

const show = async (props: Partial<ComponentProps<typeof PullRequestChip>> = {}) => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, retryDelay: 0 } },
  });
  const view = await renderPluginComponent(
    <QueryClientProvider client={client}>
      <PullRequestChip pullRequest={REF} showRepository={false} {...props} />
    </QueryClientProvider>,
    { id: 'pull-requests', plugin }
  );
  return { view, client };
};

/**
 * Waits until GitHub answered the request for `part` and the chip had a task to render the answer:
 * the chip looks the same while it waits as after a refusal or an empty list of checks.
 */
const answered = async (client: QueryClient, part: string) => {
  await vi.waitFor(() => expect(requested(part)).toBe(true));
  await vi.waitFor(() => expect(client.isFetching()).toBe(0));
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  localStorage.clear();
  observers.length = 0;
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PullRequestChip', () => {
  it('asks GitHub nothing more when the tab regains focus after the stale time', async () => {
    serve(pull());
    const { client } = await show();
    await answered(client, '/pulls/412');
    const asked = fetchMock.mock.calls.length;
    vi.useFakeTimers({ toFake: ['Date'], now: Date.now() + 10 * 60_000 });
    try {
      focusManager.setFocused(false);
      focusManager.setFocused(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(client.isFetching()).toBe(0);
      expect(fetchMock.mock.calls.length).toBe(asked);
    } finally {
      focusManager.setFocused(undefined);
      vi.useRealTimers();
    }
  });

  it.each([
    ['open', pull(), 'Open', 'mrpr-tone-open'],
    ['draft', pull({ draft: true }), 'Draft', 'mrpr-tone-draft'],
    ['closed', pull({ state: 'closed' }), 'Closed', 'mrpr-tone-closed'],
    ['merged', pull(MERGED), 'Merged', 'mrpr-tone-merged'],
  ])('shows the %s icon and the number', async (_, pr, state, tone) => {
    serve(pr);
    const { view } = await show();
    const chip = await view.findByRole('img', { name: new RegExp(`: ${state}`) });
    expect(chip.firstElementChild?.getAttribute('class')).toContain(tone);
    expect(chip.textContent).toBe('#412');
    expect(chip.getAttribute('aria-label')).toBe(`${LABEL}: ${state}\nAdd pull request chips`);
    // The hover card stands in for a native tooltip, which would show a second, slow one.
    expect(chip.hasAttribute('title')).toBe(false);
  });

  it('shows the repository before the number when asked', async () => {
    serve(pull({ state: 'closed' }));
    const { view } = await show({ showRepository: true });
    const chip = await view.findByRole('img', { name: /: Closed/ });
    expect(chip.querySelector('.mrpr-chip-repo')?.textContent).toBe('mindroom-chat');
    expect(chip.textContent).toBe('mindroom-chat#412');
  });

  it('leaves the repository out otherwise', async () => {
    serve(pull({ state: 'closed' }));
    const { view } = await show();
    const chip = await view.findByRole('img', { name: /: Closed/ });
    expect(chip.querySelector('.mrpr-chip-repo')).toBeNull();
    expect(view.queryByText('mindroom-chat')).toBeNull();
  });

  // The pending row is a draft's: a draft is open, so its checks show too.
  it.each([
    ['passing', pull(), [run('success')], 'mrpr-tone-success'],
    ['failing', pull(), [run('success'), run('failure')], 'mrpr-tone-failure'],
    ['pending', pull({ draft: true }), [run(null, 'in_progress')], 'mrpr-tone-warning'],
  ])('marks %s checks', async (_, pr, runs, tone) => {
    saveToken();
    serve(pr, runs);
    const { view } = await show();
    const mark = () => view.container.querySelector('.mrpr-chip-checks');
    await vi.waitFor(() => expect(mark()?.getAttribute('class')).toContain(tone));
  });

  it('marks nothing for a pull request without checks', async () => {
    saveToken();
    serve(pull());
    const { view, client } = await show();
    await view.findByRole('img', { name: /: Open/ });
    await answered(client, '/status?');
    expect(view.container.querySelector('.mrpr-chip-checks')).toBeNull();
  });

  it('asks for no checks of a pull request that is not open', async () => {
    saveToken();
    serve(pull(MERGED), [run('failure')]);
    const { view } = await show();
    await view.findByRole('img', { name: /: Merged/ });
    expect(requested('/check-runs')).toBe(false);
    expect(view.container.querySelector('.mrpr-chip-checks')).toBeNull();
  });

  it('asks for no checks without a token, and shows the state and the number', async () => {
    serve(pull(), [run('failure')]);
    const { view, client } = await show();
    const chip = await view.findByRole('img', { name: /: Open/ });
    await answered(client, '/pulls/412');
    expect(chip.textContent).toBe('#412');
    expect(requested('/check-runs')).toBe(false);
    expect(requested('/status?')).toBe(false);
    expect(view.container.querySelector('.mrpr-chip-checks')).toBeNull();
  });

  it('asks GitHub nothing until it has been on screen, then shows the state', async () => {
    vi.stubGlobal('IntersectionObserver', FakeIntersectionObserver);
    serve(pull({ state: 'closed' }));
    const { view } = await show();
    const chip = view.getByRole('img', { name: LABEL });
    expect(chip.textContent).toBe('#412');
    expect(chip.firstElementChild?.getAttribute('class')).toContain('mrpr-tone-draft');
    report(false);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
    report(true);
    await view.findByRole('img', { name: /: Closed/ });
    expect(requested('/pulls/412')).toBe(true);
  });

  it.each([
    ['not found', () => respond({ message: 'Not Found' }, 404)],
    // A limit that reset long ago, so the plugin asks GitHub again in the tests after this one.
    [
      'rate limited',
      () => respond({}, 403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': '0' }),
    ],
  ])('shows the number and the neutral icon when GitHub answers %s', async (_, answer) => {
    fetchMock.mockImplementation(async () => answer());
    const { view, client } = await show();
    await answered(client, '/pulls/412');
    const chip = view.getByRole('img', { name: LABEL });
    expect(chip.textContent).toBe('#412');
    expect(chip.firstElementChild?.getAttribute('class')).toContain('mrpr-tone-draft');
    expect(chip.hasAttribute('title')).toBe(false);
    expect(requested('/check-runs')).toBe(false);
  });

  it('is a span without a tab stop when it has nothing to select', async () => {
    serve(pull({ state: 'closed' }));
    const { view } = await show();
    const chip = await view.findByRole('img', { name: /: Closed/ });
    expect(chip.tagName).toBe('SPAN');
    expect(chip.hasAttribute('tabindex')).toBe(false);
    expect(view.container.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it('is a button that calls onSelect', async () => {
    serve(pull({ state: 'closed' }));
    const onSelect = vi.fn();
    const { view } = await show({ onSelect });
    const chip = await view.findByRole('button', { name: /: Closed/ });
    chip.click();
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(chip.hasAttribute('aria-pressed')).toBe(false);
    expect(chip.classList.contains('mrpr-chip-selected')).toBe(false);
  });

  it('is pressed and ringed when selected', async () => {
    serve(pull({ state: 'closed' }));
    const { view } = await show({ onSelect: vi.fn(), selected: true });
    const chip = await view.findByRole('button', { name: /: Closed/ });
    expect(chip.getAttribute('aria-pressed')).toBe('true');
    expect(chip.classList.contains('mrpr-chip-selected')).toBe(true);
  });
});

const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000).toISOString();
const user = (login: string) => ({ login, avatar_url: null, html_url: null, type: 'User' });

/** A pull request with all that its hover card shows. */
const full = (over: Record<string, unknown> = {}) =>
  pull({
    user: user('ann'),
    labels: ['ui', 'chips', 'tests', 'docs', 'e2e', 'a11y', 'theme'].map((name) => ({
      name,
      color: '0e8a16',
    })),
    requested_reviewers: [user('dee')],
    requested_teams: [{ name: 'core' }],
    mergeable_state: 'clean',
    auto_merge: { merge_method: 'squash' },
    head: { sha: SHA, ref: 'chip-hover-card' },
    base: { ref: 'main' },
    comments: 2,
    review_comments: 3,
    commits: 4,
    created_at: ago(2 * 24 * 60),
    updated_at: ago(3 * 60),
    additions: 120,
    deletions: 30,
    changed_files: 6,
    ...over,
  });

const approval = (login: string) => ({
  id: 1,
  state: 'APPROVED',
  user: user(login),
  body: '',
  commit_id: SHA,
  submitted_at: ago(60),
  html_url: '',
});

const FINE = '(hover: hover) and (pointer: fine)';

/** A screen whose pointer hovers and points finely (a mouse), or one that does not (a touch screen). */
const pointer = (fine: boolean) =>
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: fine && query === FINE,
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));

const hover = (chip: Element) => chip.dispatchEvent(new MouseEvent('mouseenter'));

/** A finger that comes down on the chip. */
const touch = (chip: Element) =>
  chip.dispatchEvent(Object.assign(new MouseEvent('pointerdown'), { pointerType: 'touch' }));

const escape = () =>
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));

/** Waits past the card's delay. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 300));

const card = () => document.querySelector<HTMLElement>('[role="tooltip"]');

/** Hovers the chip once GitHub sent its pull request, and waits for the card. */
const openCard = async (props: Partial<ComponentProps<typeof PullRequestChip>> = {}) => {
  pointer(true);
  const shown = await show(props);
  const chip = await shown.view.findByRole(props.onSelect ? 'button' : 'img', { name: /: / });
  hover(chip);
  const tooltip = await shown.view.findByRole('tooltip');
  return { ...shown, chip, tooltip };
};

const text = (element: Element | null | undefined) => element?.textContent ?? '';

describe('PullRequestChip hover card', () => {
  it('opens 150 ms after a mouse comes to rest on the chip, not before', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show();
    const chip = await view.findByRole('img', { name: /: Open/ });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      hover(chip);
      vi.advanceTimersByTime(149);
      await new Promise((resolve) => setImmediate(resolve));
      expect(card()).toBeNull();
      vi.advanceTimersByTime(1);
      await vi.waitFor(() => expect(card()).not.toBeNull());
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens nowhere a pointer cannot hover finely, such as a touch screen', async () => {
    serve(pull());
    pointer(false);
    const { view } = await show();
    const chip = await view.findByRole('img', { name: /: Open/ });
    hover(chip);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(card()).toBeNull();
  });

  it('opens for no tap on a screen that also has a mouse', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show();
    const chip = await view.findByRole('img', { name: /: Open/ });
    chip.dispatchEvent(Object.assign(new MouseEvent('pointerenter'), { pointerType: 'touch' }));
    hover(chip);
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(card()).toBeNull();
  });

  it('closes on Escape, on a click and when the pointer leaves', async () => {
    serve(pull());
    const { chip } = await openCard();
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await vi.waitFor(() => expect(card()).toBeNull());
    hover(chip);
    await vi.waitFor(() => expect(card()).not.toBeNull());
    chip.click();
    await vi.waitFor(() => expect(card()).toBeNull());
    hover(chip);
    await vi.waitFor(() => expect(card()).not.toBeNull());
    chip.dispatchEvent(new MouseEvent('mouseleave'));
    await vi.waitFor(() => expect(card()).toBeNull());
  });

  it('opens on a strip chip that the keyboard focused, and closes when it loses the focus', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show({ onSelect: () => {} });
    const chip = await view.findByRole('button', { name: /: Open/ });
    chip.focus();
    await vi.waitFor(() => expect(card()).not.toBeNull());
    chip.blur();
    await vi.waitFor(() => expect(card()).toBeNull());
  });

  it('opens for no focus without the focus ring, as a click or a tap gives', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show({ onSelect: () => {} });
    const chip = await view.findByRole('button', { name: /: Open/ });
    // jsdom matches :focus-visible on any focus; a browser does not on a click's or a tap's.
    const matches = chip.matches.bind(chip);
    chip.matches = (selector: string) => selector !== ':focus-visible' && matches(selector);
    chip.focus();
    await settle();
    expect(card()).toBeNull();
  });

  it('stays closed after Escape that came just after the keyboard focused the chip', async () => {
    serve(pull());
    const { chip } = await openCard({ onSelect: () => {} });
    chip.focus();
    escape();
    await settle();
    expect(card()).toBeNull();
  });

  it('opens for no Escape pressed while it waits to open', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show();
    hover(await view.findByRole('img', { name: /: Open/ }));
    escape();
    await settle();
    expect(card()).toBeNull();
  });

  it('opens for no touch that starts while it waits to open', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show();
    const chip = await view.findByRole('img', { name: /: Open/ });
    hover(chip);
    touch(chip);
    await settle();
    expect(card()).toBeNull();
  });

  it('closes when a touch starts on the chip', async () => {
    serve(pull());
    const { chip } = await openCard();
    touch(chip);
    await vi.waitFor(() => expect(card()).toBeNull());
  });

  it('opens for no rest of a mouse that the screen can no longer hover with', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show();
    hover(await view.findByRole('img', { name: /: Open/ }));
    pointer(false);
    await settle();
    expect(card()).toBeNull();
  });

  it.each([
    ['after a touch on it', true, true],
    ['where the pointer cannot hover', false, false],
  ])('opens on a strip chip that the keyboard focused %s', async (_, fine, touched) => {
    serve(pull());
    pointer(fine);
    const { view } = await show({ onSelect: () => {} });
    const chip = await view.findByRole('button', { name: /: Open/ });
    if (touched) touch(chip);
    chip.focus();
    await vi.waitFor(() => expect(card()).not.toBeNull());
  });

  it('opens above a chip in the lower half of the window, held there by its bottom edge', async () => {
    serve(pull());
    pointer(true);
    const { view } = await show();
    const chip = await view.findByRole('img', { name: /: Open/ });
    const bottom = window.innerHeight - 40;
    chip.getBoundingClientRect = () =>
      ({ left: 10, right: 70, top: bottom - 20, bottom, width: 60, height: 20 } as DOMRect);
    hover(chip);
    await vi.waitFor(() => expect(card()).not.toBeNull());
    // The rem is 16 pixels here, so the gap to the chip is 4.
    expect(card()?.style.bottom).toBe('64px');
    expect(card()?.style.top).toBe('');
  });

  it('shows all of an open pull request, its checks and its reviews', async () => {
    saveToken();
    serve(full(), [run('success'), run('failure')], [approval('bob')]);
    const { tooltip } = await openCard();
    const row = (name: string) => tooltip.querySelector(`.mrpr-hover-${name}`);
    expect(text(row('head'))).toContain('mindroom-ai/mindroom-chat #412');
    expect(text(row('head'))).toContain('Open');
    expect(text(row('head'))).toContain('Auto-merge (squash)');
    expect(text(row('title'))).toBe('Add pull request chips');
    expect(text(row('people'))).toContain('ann');
    expect(text(row('people'))).toContain('opened 2 days ago');
    expect(text(row('people'))).toContain('updated 3 hours ago');
    expect(text(row('branches'))).toBe('chip-hover-card→main');
    expect(text(row('size'))).toContain('+120-30');
    expect(text(row('size'))).toContain('6 files');
    expect(text(row('size'))).toContain('4 commits');
    expect(text(row('size'))).toContain('5 comments');
    await vi.waitFor(() => expect(text(row('checks'))).toBe('1 of 2 failing'));
    expect(row('checks')?.querySelector('.mrpr-tone-failure')).not.toBeNull();
    await vi.waitFor(() => expect(text(row('reviews'))).toContain('bob'));
    // An avatar without an image shows the login's initial, so a reviewer is found by its login.
    const reviewer = (login: string) =>
      [...tooltip.querySelectorAll('.mrpr-hover-reviewer')].find(
        (entry) => text(entry.querySelector('.mrpr-actor-login')) === login
      );
    expect(text(reviewer('bob'))).toContain('Approved');
    expect(reviewer('bob')?.querySelector('.mrpr-tone-success')).not.toBeNull();
    expect(text(reviewer('dee'))).toContain('Awaiting review');
    expect(text(row('reviews'))).toContain('core');
    const labels = [...(row('labels')?.querySelectorAll('.mrpr-label') ?? [])].map(text);
    expect(labels).toEqual(['ui', 'chips', 'tests', 'docs', 'e2e']);
    expect(text(row('labels'))).toContain('+2');
    // A chip that opens nothing in a side panel says nothing of one.
    expect(row('hint')).toBeNull();
    // It is read-only: nothing in it takes the focus or a click.
    expect(tooltip.querySelector('button, a, input, [tabindex]')).toBeNull();
  });

  it('shows when a merged pull request was merged, and no checks', async () => {
    saveToken();
    serve(full({ state: 'closed', merged_at: ago(120), closed_at: ago(120) }), [run('failure')]);
    const { tooltip } = await openCard();
    expect(text(tooltip.querySelector('.mrpr-hover-head'))).toContain('Merged');
    expect(text(tooltip.querySelector('.mrpr-hover-people'))).toContain('merged 2 hours ago');
    expect(text(tooltip.querySelector('.mrpr-hover-people'))).not.toContain('updated');
    expect(tooltip.querySelector('.mrpr-hover-checks')).toBeNull();
    expect(requested('/check-runs')).toBe(false);
  });

  it('shows when a closed pull request was closed', async () => {
    serve(full({ state: 'closed', closed_at: ago(120) }));
    const { tooltip } = await openCard();
    expect(text(tooltip.querySelector('.mrpr-hover-people'))).toContain('closed 2 hours ago');
  });

  it('shows a draft as one, and no checks without a token', async () => {
    serve(full({ draft: true }), [run('failure')]);
    const { tooltip } = await openCard();
    expect(text(tooltip.querySelector('.mrpr-hover-head'))).toContain('Draft');
    expect(tooltip.querySelector('.mrpr-hover-checks')).toBeNull();
  });

  it.each([
    ['dirty', 'Conflicts with main'],
    ['behind', 'Behind main'],
  ])('warns of a branch that is %s', async (state, warning) => {
    serve(full({ mergeable_state: state }));
    const { tooltip } = await openCard();
    expect(text(tooltip.querySelector('.mrpr-hover-base-warning'))).toBe(warning);
  });

  it('warns of nothing for a clean branch', async () => {
    serve(full());
    const { tooltip } = await openCard();
    expect(tooltip.querySelector('.mrpr-hover-base-warning')).toBeNull();
  });

  it('shows the approval of a reviewer asked again after it, as the panel does', async () => {
    saveToken();
    serve(full({ requested_reviewers: [user('bob')] }), [], [approval('bob')]);
    const { tooltip } = await openCard();
    const bob = () =>
      [...tooltip.querySelectorAll('.mrpr-hover-reviewer')].find(
        (entry) => text(entry.querySelector('.mrpr-actor-login')) === 'bob'
      );
    await vi.waitFor(() => expect(text(bob())).toContain('Approved'));
    expect(tooltip.querySelectorAll('.mrpr-hover-reviewer')).toHaveLength(1);
  });

  it('shows six reviewers at most, teams among them, and counts the rest', async () => {
    saveToken();
    const asked = ['a', 'b', 'c', 'd', 'e', 'f', 'g'].map(user);
    serve(full({ requested_reviewers: asked, requested_teams: [{ name: 'core' }] }));
    const { tooltip } = await openCard();
    const row = () => tooltip.querySelector('.mrpr-hover-reviews');
    await vi.waitFor(() =>
      expect(tooltip.querySelectorAll('.mrpr-hover-reviewer')).toHaveLength(6)
    );
    expect(text(row())).toContain('+2');
    expect(text(row())).not.toContain('core');
  });

  it('asks for the reviews only once the card opens, in one request', async () => {
    saveToken();
    serve(full(), [], [approval('bob')]);
    pointer(true);
    const { view, client } = await show();
    const chip = await view.findByRole('img', { name: /: Open/ });
    await answered(client, '/pulls/412');
    expect(requested('/reviews')).toBe(false);
    hover(chip);
    await view.findByRole('tooltip');
    await answered(client, '/reviews');
    expect(fetchMock.mock.calls.filter(([url]) => url.includes('/reviews')).length).toBe(1);
  });

  it('asks for no reviews without a token, and leaves their row out', async () => {
    serve(full(), [], [approval('bob')]);
    const { tooltip, client } = await openCard();
    await answered(client, '/pulls/412');
    await settle();
    expect(requested('/reviews')).toBe(false);
    expect(tooltip.querySelector('.mrpr-hover-reviews')).toBeNull();
  });

  it('keeps the reviews row while they load, and leaves it out when they fail', async () => {
    saveToken();
    let answer: (response: Response) => void = () => {};
    fetchMock.mockImplementation(async (url) => {
      if (url.includes('/reviews?')) return new Promise<Response>((resolve) => (answer = resolve));
      return respond(full());
    });
    const { tooltip } = await openCard();
    const row = () => tooltip.querySelector('.mrpr-hover-reviews');
    await vi.waitFor(() => expect(text(row())).toBe('Loading reviewers'));
    // A refusal, which the queries do not ask again (a failed request they would).
    answer(respond({ message: 'Not Found' }, 404));
    await vi.waitFor(() => expect(row()).toBeNull());
  });

  it('says so when there are no reviews and nobody is asked', async () => {
    saveToken();
    serve(full({ requested_reviewers: [], requested_teams: [] }));
    const { tooltip } = await openCard();
    await vi.waitFor(() =>
      expect(text(tooltip.querySelector('.mrpr-hover-reviews'))).toBe('No reviews yet')
    );
  });

  it.each([
    ['a strip chip', { onSelect: () => {} }],
    ['a card chip with a side panel', { opensPanel: true }],
  ])('tells that a click on %s opens the side panel', async (_, props) => {
    serve(full());
    const { tooltip } = await openCard(props);
    expect(text(tooltip.querySelector('.mrpr-hover-hint'))).toBe('Click to open in the side panel');
  });

  it('says nothing of the side panel on a pressed strip chip, whose pull request it shows', async () => {
    serve(full());
    const { tooltip } = await openCard({ onSelect: () => {}, selected: true });
    expect(tooltip.querySelector('.mrpr-hover-hint')).toBeNull();
  });

  it('describes a strip chip by its card while the card is open', async () => {
    serve(full());
    const { chip, tooltip } = await openCard({ onSelect: () => {} });
    expect(tooltip.id).not.toBe('');
    expect(chip.getAttribute('aria-describedby')).toBe(tooltip.id);
    chip.dispatchEvent(new MouseEvent('mouseleave'));
    await vi.waitFor(() => expect(card()).toBeNull());
    expect(chip.hasAttribute('aria-describedby')).toBe(false);
  });

  it('describes no card chip by its card, which is inside the thread card button', async () => {
    serve(full());
    const { chip } = await openCard({ opensPanel: true });
    expect(chip.hasAttribute('aria-describedby')).toBe(false);
  });

  it('shows the repository and the number while the pull request loads', async () => {
    fetchMock.mockImplementation(() => new Promise<Response>(() => {}));
    pointer(true);
    const { view } = await show();
    hover(view.getByRole('img', { name: LABEL }));
    const tooltip = await view.findByRole('tooltip');
    expect(text(tooltip.querySelector('.mrpr-hover-head'))).toBe('mindroom-ai/mindroom-chat #412');
    expect(text(tooltip.querySelector('.mrpr-status'))).toBe('Loading pull request');
  });

  it('shows the repository, the number and why when GitHub refused', async () => {
    fetchMock.mockImplementation(async () => respond({ message: 'Not Found' }, 404));
    pointer(true);
    const { view, client } = await show();
    await answered(client, '/pulls/412');
    hover(view.getByRole('img', { name: LABEL }));
    const tooltip = await view.findByRole('tooltip');
    expect(text(tooltip.querySelector('.mrpr-hover-head'))).toBe('mindroom-ai/mindroom-chat #412');
    expect(text(tooltip.querySelector('.mrpr-status'))).toBe(
      'GitHub did not find this pull request. A private repository needs a token.'
    );
    expect(tooltip.querySelector('button')).toBeNull();
  });
});
