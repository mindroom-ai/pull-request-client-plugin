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

/** GitHub with the pull request `pr`, whose head commit has the check runs `runs`. */
const serve = (pr: unknown, runs: unknown[] = []) =>
  fetchMock.mockImplementation(async (url) => {
    if (url.endsWith('/repos/mindroom-ai/mindroom-chat/pulls/412')) return respond(pr);
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
    expect(chip.getAttribute('title')).toBe(`${LABEL}: ${state}\nAdd pull request chips`);
    expect(chip.getAttribute('aria-label')).toBe(chip.getAttribute('title'));
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
    expect(chip.getAttribute('title')).toBe(LABEL);
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
