// @vitest-environment jsdom
import type { ReactNode } from 'react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act } from '../testing/act';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckStatus, PullRequest, PullRequestCheck } from '../github';
import plugin from '../index';
import { ChecksPopover } from './ChecksPopover';
import { CHECKS_HOVER_CLOSE_MS, CHECKS_HOVER_OPEN_MS, ChecksStatusLine } from './ChecksStatusLine';

// The options the popover gives its focus trap, which a test calls as the trap would on Escape and
// on a click outside.
const trap = vi.hoisted(() => ({
  active: undefined as boolean | undefined,
  options: undefined as
    | {
        escapeDeactivates: () => boolean;
        clickOutsideDeactivates: (event?: MouseEvent | TouchEvent) => boolean;
        allowOutsideClick?: (event?: MouseEvent | TouchEvent) => boolean;
      }
    | undefined,
}));
vi.mock('focus-trap-react', () => ({
  default: ({
    children,
    active = true,
    focusTrapOptions,
  }: {
    children: ReactNode;
    active?: boolean;
    focusTrapOptions: NonNullable<typeof trap.options>;
  }) => {
    trap.active = active;
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
  const pullRequest = { headSha: 'abc123', url: 'https://github.com/a/b/pull/1' } as PullRequest;
  const respond = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'content-type': 'application/json' },
    });
  const runs = (conclusions: string[], labels?: string[]) => ({
    check_runs: conclusions.map((conclusion, index) => ({
      name: labels?.[index] ?? `job ${index}`,
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
  const pointer = (
    target: EventTarget,
    type: 'pointerover' | 'pointerout' | 'pointerdown',
    { pointerType = 'mouse', buttons = 0 } = {}
  ) =>
    act(async () => {
      target.dispatchEvent(
        Object.assign(new MouseEvent(type, { bubbles: true, buttons }), { pointerType })
      );
    });
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
  const openHover = async (button: HTMLElement) => {
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS);
  };
  const showHoverable = async () => {
    fetchMock.mockImplementation(async (url) =>
      respond(
        url.includes('/check-runs')
          ? runs(['failure', 'success', 'success'], ['lint', 'build', 'test'])
          : { statuses: [] }
      )
    );
    const view = await show();
    const button = await view.findByRole('button', { name: /1 of 3 failing/ });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return { view, button };
  };

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    trap.active = undefined;
    trap.options = undefined;
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

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
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    // The popover holds a list and links, not a menu of choices.
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    expect(view.queryByRole('menu')).toBeNull();
    expect(view.getByText('job 0')).toBeTruthy();
    act(() => void trap.options?.escapeDeactivates());
    expect(view.queryByText('Some checks were not successful')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the passed over all as its short form, with the whole summary as its tooltip', async () => {
    fetchMock.mockImplementation(async (url) =>
      respond(
        url.includes('/check-runs') ? runs(['success', 'skipped', 'skipped']) : { statuses: [] }
      )
    );
    const view = await show();
    const button = await view.findByRole('button', { name: 'Open checks: 1 passed, 2 skipped' });
    expect(button.getAttribute('title')).toBe('1 passed, 2 skipped');
    // Both forms are there; the tab bar's width picks the one that shows (styles.css).
    expect(button.querySelector('.mrpr-checks-full')?.textContent).toBe('1 passed, 2 skipped');
    expect(button.querySelector('.mrpr-checks-short')?.textContent).toBe('1/3');
  });

  it('marks checks that were all skipped with the muted skipped icon, not a passing one', async () => {
    fetchMock.mockImplementation(async (url) =>
      respond(url.includes('/check-runs') ? runs(['skipped', 'neutral']) : { statuses: [] })
    );
    const view = await show();
    const button = await view.findByRole('button', { name: /Open checks: 0 passed/ });
    const icon = button.querySelector('svg');
    expect(icon?.classList.contains('mrpr-tone-muted')).toBe(true);
    expect(icon?.classList.contains('mrpr-tone-success')).toBe(false);
  });

  it('says so when GitHub has more check runs than it sent', async () => {
    fetchMock.mockImplementation(async (url) =>
      respond(
        url.includes('/check-runs')
          ? { ...runs(['failure', 'success']), total_count: 150 }
          : { statuses: [] }
      )
    );
    const view = await show();
    await click(await view.findByRole('button', { name: /1 of 2 failing/ }));
    const note = await view.findByRole('link', {
      name: 'Showing the first 2; see the rest on GitHub',
    });
    expect(note.getAttribute('href')).toBe('https://github.com/a/b/pull/1/checks');
  });

  it('lists the statuses when the check runs are refused', async () => {
    fetchMock.mockImplementation(async (url) =>
      url.includes('/check-runs')
        ? respond({ message: 'Resource not accessible by personal access token' }, 403)
        : respond({ statuses: [{ context: 'ci/build', state: 'failure' }] })
    );
    const view = await show();
    await click(await view.findByRole('button', { name: /1 of 1 failing/ }));
    expect(await view.findByText('ci/build')).toBeTruthy();
    expect(view.queryByText('Checks unavailable')).toBeNull();
  });

  it('closes the popover when its trigger is clicked again', async () => {
    fetchMock.mockImplementation(async (url) =>
      respond(url.includes('/check-runs') ? runs(['failure']) : { statuses: [] })
    );
    const view = await show();
    const button = await view.findByRole('button', { name: /1 of 1 failing/ });
    await click(button);
    expect(await view.findByText('Some checks were not successful')).toBeTruthy();
    await click(button);
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
    const unavailable = await view.findByText('Checks unavailable');
    expect(unavailable.getAttribute('title')).toBe('Checks unavailable');
    fetchMock.mockImplementation(async (url) =>
      respond(url.includes('/check-runs') ? runs(['success']) : { statuses: [] })
    );
    await click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByText('All checks have passed')).toBeTruthy();
  });

  it('opens on mouse hover after CHECKS_HOVER_OPEN_MS with inactive trap, data-owns-focus, and hidden title', async () => {
    const { view, button } = await showHoverable();
    expect(button.getAttribute('title')).toBe('1 of 3 failing');
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS - 1);
    expect(view.queryByRole('dialog')).toBeNull();
    await advance(1);
    const dialog = view.getByRole('dialog', { name: 'Checks' });
    expect(view.getByText('Some checks were not successful')).toBeTruthy();
    expect(view.getByText('lint')).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('title')).toBeNull();
    expect(trap.active).toBe(false);
    const layer = dialog.closest('[data-owns-focus]') as HTMLElement | null;
    expect(layer?.getAttribute('data-owns-focus')).toBe('');
    expect(layer?.style.pointerEvents).toBe('none');
    expect(dialog.style.pointerEvents).toBe('auto');
  });

  it('does not open when the mouse leaves before CHECKS_HOVER_OPEN_MS', async () => {
    const { view, button } = await showHoverable();
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS - 1);
    await pointer(button, 'pointerout');
    await advance(CHECKS_HOVER_OPEN_MS);
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('stays open across button and popover within CHECKS_HOVER_CLOSE_MS and closes after leaving', async () => {
    const { view, button } = await showHoverable();
    await openHover(button);
    const dialog = view.getByRole('dialog', { name: 'Checks' });
    await pointer(button, 'pointerout');
    await advance(CHECKS_HOVER_CLOSE_MS - 1);
    await pointer(dialog, 'pointerover');
    await advance(CHECKS_HOVER_CLOSE_MS);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    await pointer(dialog, 'pointerout');
    await advance(CHECKS_HOVER_CLOSE_MS - 1);
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_CLOSE_MS);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    await pointer(button, 'pointerout');
    await pointer(dialog, 'pointerover');
    await pointer(dialog, 'pointerout');
    await advance(CHECKS_HOVER_CLOSE_MS - 1);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    await advance(1);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('title')).toBe('1 of 3 failing');
  });

  it('pins in place on click while hover-open, keeping Show all expanded until clicked again', async () => {
    const { view, button } = await showHoverable();
    await openHover(button);
    await click(view.getByRole('button', { name: 'Show all' }));
    expect(view.getByText('build')).toBeTruthy();
    await pointer(button, 'pointerdown');
    await click(button);
    const dialog = view.getByRole('dialog', { name: 'Checks' });
    expect(view.getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(trap.active).toBe(true);
    expect(dialog.closest('[data-owns-focus]')).toBeNull();
    await pointer(button, 'pointerout');
    await pointer(dialog, 'pointerout');
    await advance(CHECKS_HOVER_CLOSE_MS * 2);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    const onButton = new MouseEvent('mousedown', { bubbles: true });
    Object.defineProperty(onButton, 'target', { value: button });
    expect(trap.options?.clickOutsideDeactivates(onButton)).toBe(false);
    expect(trap.options?.allowOutsideClick?.(onButton)).toBe(true);
    await click(button);
    expect(view.queryByRole('dialog')).toBeNull();
  });

  it('ignores touch/pen hover and mouse hover while buttons are pressed', async () => {
    const { view, button } = await showHoverable();
    for (const init of [
      { pointerType: 'touch' },
      { pointerType: 'pen' },
      { pointerType: 'mouse', buttons: 1 },
    ]) {
      await pointer(button, 'pointerover', init);
      await advance(CHECKS_HOVER_OPEN_MS);
      expect(view.queryByRole('dialog')).toBeNull();
    }
  });

  it('closes hover popover on Escape (focusing button only from inside) and outside pointerdown', async () => {
    const { view, button } = await showHoverable();
    const sendEscape = async () => {
      const event = new KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
        cancelable: true,
      });
      await act(async () => void document.dispatchEvent(event));
      return event;
    };
    await openHover(button);
    const outsideEscape = await sendEscape();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(outsideEscape.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(button);

    await openHover(button);
    view.getByRole('button', { name: 'Show all' }).focus();
    const insideEscape = await sendEscape();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(insideEscape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);

    await openHover(button);
    await pointer(view.getByRole('dialog', { name: 'Checks' }), 'pointerdown');
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    await pointer(document.body, 'pointerdown');
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
