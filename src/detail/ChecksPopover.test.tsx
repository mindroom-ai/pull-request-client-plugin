// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckStatus, PullRequest, PullRequestCheck } from '../github';
import plugin from '../index';
import { ChecksPopover } from './ChecksPopover';
import { ChecksStatusLine } from './ChecksStatusLine';

// The options the popover gives its focus trap, which a test calls as the trap would on Escape and
// on a click outside.
const trap = vi.hoisted(() => ({
  options: undefined as
    | { escapeDeactivates: () => boolean; clickOutsideDeactivates: () => boolean }
    | undefined,
}));
vi.mock('focus-trap-react', () => ({
  default: ({
    children,
    focusTrapOptions,
  }: {
    children: ReactNode;
    focusTrapOptions: NonNullable<typeof trap.options>;
  }) => {
    trap.options = focusTrapOptions;
    return children;
  },
}));

const check = (
  status: CheckStatus,
  name: string,
  over: Partial<PullRequestCheck> = {}
): PullRequestCheck => ({ name, status, description: null, url: null, updatedAt: null, ...over });

const render = (ui: React.ReactElement) =>
  renderPluginComponent(ui, { id: 'pull-requests', plugin });

const click = (element: HTMLElement) => act(async () => element.click());
const names = (view: Awaited<ReturnType<typeof render>>) =>
  [...view.container.querySelectorAll('.mrpr-check-name')].map((n) => n.textContent);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('ChecksPopover', () => {
  it('states the overall result and the summary', async () => {
    const view = await render(
      <ChecksPopover checks={[check('failure', 'lint'), check('success', 'test')]} />
    );
    expect(view.getByText('Some checks were not successful')).toBeTruthy();
    expect(view.getByText('1 of 2 failing')).toBeTruthy();
  });

  it('lists what needs attention first, then running, and hides completed behind Show all', async () => {
    const view = await render(
      <ChecksPopover
        checks={[
          check('success', 'build'),
          check('pending', 'deploy'),
          check('failure', 'lint', { description: 'Lint failed', url: 'https://example.org/lint' }),
          check('action-required', 'review'),
        ]}
      />
    );
    expect(names(view)).toEqual(['lint', 'review', 'deploy']);
    expect(view.getByText('Failed')).toBeTruthy();
    expect(view.getByText('Running')).toBeTruthy();
    expect(view.getByText('lint').title).toBe('Lint failed');
    const details = view.getByText('Details') as HTMLAnchorElement;
    expect(details.href).toBe('https://example.org/lint');
    expect(details.target).toBe('_blank');
    expect(details.rel).toBe('noopener noreferrer');
    const toggle = view.getByText('Show all');
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    await click(toggle);
    expect(names(view)).toEqual(['lint', 'review', 'deploy', 'build']);
    expect(view.getByText('Show less').getAttribute('aria-expanded')).toBe('true');
    await click(view.getByText('Show less'));
    expect(names(view)).toEqual(['lint', 'review', 'deploy']);
  });

  it('shows every completed check, with no toggle, when nothing else is listed', async () => {
    const view = await render(
      <ChecksPopover checks={[check('success', 'build'), check('skipped', 'docs')]} />
    );
    expect(names(view)).toEqual(['build', 'docs']);
    expect(view.queryByText('Show all')).toBeNull();
    expect(view.container.querySelector('.mrpr-checks-heading')?.textContent).toBe(
      'All checks have passed'
    );
  });

  it('says so when there are no checks', async () => {
    const view = await render(<ChecksPopover checks={[]} />);
    expect(view.getByText('No checks reported')).toBeTruthy();
  });
});

describe('ChecksStatusLine', () => {
  const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>();
  const ref = { owner: 'a', repo: 'b', number: 1 };
  const pullRequest = { headSha: 'abc123' } as PullRequest;
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const runs = (conclusions: string[]) => ({
    check_runs: conclusions.map((conclusion, index) => ({
      name: `job ${index}`,
      status: 'completed',
      conclusion,
      html_url: `https://github.com/a/b/runs/${index}`,
    })),
  });
  const show = () =>
    render(
      <QueryClientProvider
        client={new QueryClient({ defaultOptions: { queries: { retry: false, retryDelay: 0 } } })}
      >
        <ChecksStatusLine pullRequest={pullRequest} pullRequestRef={ref} />
      </QueryClientProvider>
    );

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => vi.unstubAllGlobals());

  it('summarizes the checks and opens the popover, which Escape closes', async () => {
    fetchMock.mockImplementation(async (url) =>
      respond(
        url.includes('/check-runs') ? runs(['failure', 'success', 'success']) : { statuses: [] }
      )
    );
    const view = await show();
    const button = await view.findByRole('button', { name: /1 of 3 failing/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await click(button);
    expect(await view.findByText('Some checks were not successful')).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(view.getByText('job 0')).toBeTruthy();
    act(() => void trap.options?.escapeDeactivates());
    expect(view.queryByText('Some checks were not successful')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a click outside too', async () => {
    fetchMock.mockImplementation(async (url) =>
      respond(url.includes('/check-runs') ? runs(['success']) : { statuses: [] })
    );
    const view = await show();
    await click(await view.findByRole('button', { name: /All checks have passed/ }));
    expect(await view.findByText('job 0')).toBeTruthy();
    act(() => void trap.options?.clickOutsideDeactivates());
    expect(view.queryByText('job 0')).toBeNull();
  });

  it('says No checks for none, also when GitHub answers 404', async () => {
    fetchMock.mockImplementation(async () => respond({}, 404));
    const view = await show();
    expect(await view.findByText('No checks')).toBeTruthy();
    expect(view.queryByRole('button')).toBeNull();
  });

  it('says Checks unavailable with Retry on an error', async () => {
    fetchMock.mockImplementation(async () => respond({}, 500));
    const view = await show();
    expect(await view.findByText('Checks unavailable')).toBeTruthy();
    fetchMock.mockImplementation(async (url) =>
      respond(url.includes('/check-runs') ? runs(['success']) : { statuses: [] })
    );
    await click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByText('All checks have passed')).toBeTruthy();
  });
});
