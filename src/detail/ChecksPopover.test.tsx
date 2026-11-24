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

type TrapOptions = {
  initialFocus?: unknown;
  fallbackFocus?: () => HTMLElement;
  preventScroll?: boolean;
  escapeDeactivates: () => boolean;
  clickOutsideDeactivates: (event?: MouseEvent | TouchEvent) => boolean;
};
const trap = vi.hoisted(() => ({
  active: undefined as boolean | undefined,
  options: undefined as TrapOptions | undefined,
}));
vi.mock('focus-trap-react', () => ({
  default: (p: { children: ReactNode; active?: boolean; focusTrapOptions: TrapOptions }) => {
    trap.active = p.active ?? true;
    trap.options = p.focusTrapOptions;
    return p.children;
  },
}));

const check = (status: CheckStatus, name: string, over: Partial<PullRequestCheck> = {}) =>
  ({ name, status, description: null, url: null, updatedAt: null, ...over }) as PullRequestCheck;
const render = (ui: React.ReactElement) =>
  renderPluginComponent(ui, { id: 'pull-requests', plugin });
const click = (el: HTMLElement) => act(async () => el.click());
const focus = (el: HTMLElement) => act(async () => el.focus());
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
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const mockRuns = (conclusions: string[], labels?: string[], extra?: Record<string, unknown>) =>
    fetchMock.mockImplementation(async (url) =>
      respond(
        url.includes('/check-runs')
          ? {
              check_runs: conclusions.map((conclusion, i) => ({
                name: labels?.[i] ?? `job ${i}`,
                status: 'completed',
                conclusion,
                html_url: `https://github.com/a/b/runs/${i}`,
              })),
              ...extra,
            }
          : { statuses: [] }
      )
    );
  const show = () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, retryDelay: 0 } },
    });
    return render(
      <QueryClientProvider client={client}>
        <ChecksStatusLine pullRequest={pullRequest} pullRequestRef={ref} />
      </QueryClientProvider>
    );
  };
  const pointer = (
    target: EventTarget,
    type: 'pointerover' | 'pointerout' | 'pointerdown' | 'pointermove',
    { pointerType = 'mouse', buttons = 0, clientX = 0, clientY = 0 } = {}
  ) =>
    act(async () => {
      const ev = new MouseEvent(type, { bubbles: true, buttons, clientX, clientY });
      target.dispatchEvent(Object.assign(ev, { pointerType }));
    });
  const advance = (ms: number) => act(async () => void vi.advanceTimersByTime(ms));
  const openHover = async (btn: HTMLElement) => {
    await pointer(btn, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS);
  };
  const pin = async (btn: HTMLElement) => {
    await pointer(btn, 'pointerdown');
    await click(btn);
  };
  const closeOutside = (event?: MouseEvent) => {
    let closed = false;
    act(() => void (closed = trap.options?.clickOutsideDeactivates(event) ?? false));
    return closed;
  };
  const mockBox = (el: HTMLElement) =>
    vi
      .spyOn(el, 'getBoundingClientRect')
      .mockReturnValue(DOMRect.fromRect({ width: 80, height: 30 }));
  const showHoverable = async () => {
    mockRuns(['failure', 'success', 'success'], ['lint', 'build', 'test']);
    const view = await show();
    const button = await view.findByRole('button', { name: /1 of 3 failing/ });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    return { view, button };
  };

  beforeEach(() => {
    localStorage.clear();
    fetchMock.mockReset();
    trap.active = trap.options = undefined;
    vi.stubGlobal('fetch', fetchMock);
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('summarizes the checks and opens the popover, which Escape closes', async () => {
    mockRuns(['failure', 'success', 'success']);
    const view = await show();
    const button = await view.findByRole('button', { name: /1 of 3 failing/ });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    await click(button);
    expect(await view.findByText('Some checks were not successful')).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('aria-haspopup')).toBe('dialog');
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    expect(view.queryByRole('menu')).toBeNull();
    expect(view.getByText('job 0')).toBeTruthy();
    act(() => void trap.options?.escapeDeactivates());
    expect(view.queryByText('Some checks were not successful')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows the passed over all as its short form, with the whole summary as its tooltip', async () => {
    mockRuns(['success', 'skipped', 'skipped']);
    const view = await show();
    const button = await view.findByRole('button', { name: 'Open checks: 1 passed, 2 skipped' });
    expect(button.getAttribute('title')).toBe('1 passed, 2 skipped');
    expect(button.querySelector('.mrpr-checks-full')?.textContent).toBe('1 passed, 2 skipped');
    expect(button.querySelector('.mrpr-checks-short')?.textContent).toBe('1/3');
  });

  it('marks checks that were all skipped with the muted skipped icon, not a passing one', async () => {
    mockRuns(['skipped', 'neutral']);
    const view = await show();
    const btn = await view.findByRole('button', { name: /Open checks: 0 passed/ });
    const icon = btn.querySelector('svg');
    expect(icon?.classList.contains('mrpr-tone-muted')).toBe(true);
    expect(icon?.classList.contains('mrpr-tone-success')).toBe(false);
  });

  it('says so when GitHub has more check runs than it sent', async () => {
    mockRuns(['failure', 'success'], undefined, { total_count: 150 });
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
    mockRuns(['failure']);
    const view = await show();
    const button = await view.findByRole('button', { name: /1 of 1 failing/ });
    await click(button);
    expect(await view.findByText('Some checks were not successful')).toBeTruthy();
    await click(button);
    expect(view.queryByText('Some checks were not successful')).toBeNull();
    expect(button.getAttribute('aria-expanded')).toBe('false');
  });

  it('closes on a click outside too', async () => {
    mockRuns(['success']);
    const view = await show();
    await click(await view.findByRole('button', { name: /All checks have passed/ }));
    expect(await view.findByText('job 0')).toBeTruthy();
    closeOutside();
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
    expect((await view.findByText('Checks unavailable')).getAttribute('title')).toBe(
      'Checks unavailable'
    );
    mockRuns(['success']);
    await click(view.getByRole('button', { name: 'Retry' }));
    expect(await view.findByText('All checks have passed')).toBeTruthy();
  });

  it('opens on mouse hover after CHECKS_HOVER_OPEN_MS, ignoring early leave, touch/pen, and pressed buttons', async () => {
    const { view, button } = await showHoverable();
    expect(button.getAttribute('title')).toBe('1 of 3 failing');
    for (const init of [{ pointerType: 'touch' }, { pointerType: 'pen' }, { buttons: 1 }]) {
      await pointer(button, 'pointerover', init);
      await advance(CHECKS_HOVER_OPEN_MS);
      expect(view.queryByRole('dialog')).toBeNull();
    }
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS - 1);
    await pointer(button, 'pointerout');
    await advance(CHECKS_HOVER_OPEN_MS);
    expect(view.queryByRole('dialog')).toBeNull();
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS - 1);
    expect(view.queryByRole('dialog')).toBeNull();
    await advance(1);
    const dialog = view.getByRole('dialog', { name: 'Checks' });
    const layer = dialog.closest('[data-owns-focus]') as HTMLElement | null;
    expect(view.getByText('Some checks were not successful')).toBeTruthy();
    expect(view.getByText('lint')).toBeTruthy();
    expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(button.getAttribute('title')).toBeNull();
    expect(trap.active).toBe(false);
    expect(dialog.getAttribute('tabindex')).toBeNull();
    expect(layer?.getAttribute('data-owns-focus')).toBe('');
    expect(layer?.style.pointerEvents).toBe('none');
    expect(dialog.style.pointerEvents).toBe('auto');
  });

  it('stays open across button and popover within CHECKS_HOVER_CLOSE_MS and closes after leaving', async () => {
    const { view, button } = await showHoverable();
    await openHover(button);
    const dialog = view.getByRole('dialog', { name: 'Checks' });
    for (const [from, to] of [
      [button, dialog],
      [dialog, button],
    ] as const) {
      await pointer(from, 'pointerout');
      await advance(CHECKS_HOVER_CLOSE_MS - 1);
      await pointer(to, 'pointerover');
      await advance(CHECKS_HOVER_CLOSE_MS);
      expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    }
    await pointer(button, 'pointerout');
    await pointer(dialog, 'pointerover');
    await pointer(dialog, 'pointerout');
    await advance(CHECKS_HOVER_CLOSE_MS - 1);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    await advance(1);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(button.getAttribute('title')).toBe('1 of 3 failing');
  });

  it('pins in place on click, switching PopOut pointerEvents, tabIndex, and FocusTrap without unmounting', async () => {
    const { view, button } = await showHoverable();
    await openHover(button);
    const dialog = view.getByRole('dialog', { name: 'Checks' });
    const layer = dialog.closest('[data-owns-focus]') as HTMLElement | null;
    expect(dialog.getAttribute('tabindex')).toBeNull();
    await click(view.getByRole('button', { name: 'Show all' }));
    expect(view.getByText('build')).toBeTruthy();
    await pin(button);
    expect(view.getByRole('button', { name: 'Show less' })).toBeTruthy();
    expect(trap.active).toBe(true);
    expect(trap.options?.initialFocus).toBeUndefined();
    expect(trap.options?.preventScroll).toBe(true);
    expect(trap.options?.fallbackFocus?.()).toBe(dialog);
    expect(dialog.getAttribute('tabindex')).toBe('-1');
    expect(layer?.getAttribute('data-owns-focus')).toBeNull();
    expect(layer?.style.pointerEvents).toBe('');
    await pointer(button, 'pointerout');
    await pointer(dialog, 'pointerout');
    await advance(CHECKS_HOVER_CLOSE_MS * 2);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    closeOutside();
    await click(button);
    const pinned = view.getByRole('dialog', { name: 'Checks' });
    expect(pinned.closest('[data-owns-focus]')).toBeNull();
    const pinnedLayer = pinned.parentElement?.parentElement as HTMLElement | null;
    expect(pinnedLayer?.style.pointerEvents).toBe('');
    expect(pinned.getAttribute('tabindex')).toBe('-1');
  });

  it('returns focus to the trigger on Escape or click over the trigger, not on clicks elsewhere', async () => {
    const { view, button } = await showHoverable();
    mockBox(button);
    const openAndFocus = async () => {
      await click(button);
      await focus(view.getByRole('button', { name: 'Show all' }));
    };
    await openAndFocus();
    act(() => void trap.options?.escapeDeactivates());
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    await openAndFocus();
    const over = new MouseEvent('mousedown', { clientX: 20, clientY: 15, cancelable: true });
    expect(closeOutside(over)).toBe(true);
    expect(over.defaultPrevented).toBe(true);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(button);
    await openAndFocus();
    const away = new MouseEvent('mousedown', { clientX: 200, clientY: 200, cancelable: true });
    expect(closeOutside(away)).toBe(true);
    expect(away.defaultPrevented).toBe(false);
    expect(view.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).not.toBe(button);
  });

  it('keeps hover popover open while focus is inside it and closes on outside focusin even after null blur', async () => {
    const { view, button } = await showHoverable();
    const outside = document.createElement('button');
    document.body.appendChild(outside);
    try {
      await openHover(button);
      const dialog = view.getByRole('dialog', { name: 'Checks' });
      await pointer(button, 'pointerout');
      await pointer(dialog, 'pointerover');
      const toggle = view.getByRole('button', { name: 'Show all' });
      await click(toggle);
      await focus(toggle);
      await pointer(dialog, 'pointerout');
      await advance(CHECKS_HOVER_CLOSE_MS * 2);
      expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
      expect(document.activeElement).toBe(toggle);
      // Trigger focus or relatedTarget === null blur keeps it open until an outside focusin.
      await focus(button);
      expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
      await focus(toggle);
      await act(async () => toggle.blur());
      expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
      await focus(outside);
      expect(view.queryByRole('dialog')).toBeNull();
      await openHover(button);
      await focus(view.getByRole('button', { name: 'Show all' }));
      await focus(outside);
      expect(view.queryByRole('dialog')).toBeNull();
    } finally {
      outside.remove();
    }
  });

  it('does not reopen on synthetic pointerenter after closing a pinned popover until mouse leaves and returns', async () => {
    const { view, button } = await showHoverable();
    mockBox(button);
    await pointer(button, 'pointerover');
    await pin(button);
    await pointer(button, 'pointerout');
    closeOutside();
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS * 2);
    expect(view.queryByRole('dialog')).toBeNull();
    await pointer(document.body, 'pointermove', { clientX: 20, clientY: 15 });
    await pointer(button, 'pointerover');
    await advance(CHECKS_HOVER_OPEN_MS * 2);
    expect(view.queryByRole('dialog')).toBeNull();
    await pointer(document.body, 'pointermove', { clientX: 200, clientY: 200 });
    await openHover(button);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    await pin(button);
    await pointer(button, 'pointerout');
    await pointer(document.body, 'pointermove', { clientX: 200, clientY: 200 });
    act(() => void trap.options?.escapeDeactivates());
    expect(view.queryByRole('dialog')).toBeNull();
    await openHover(button);
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
  });

  it('closes hover popover on Escape (focusing button only from inside) and outside pointerdown', async () => {
    const { view, button } = await showHoverable();
    const sendEscape = async () => {
      const e = new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true });
      await act(async () => void document.dispatchEvent(e));
      return e;
    };
    await openHover(button);
    const outsideEscape = await sendEscape();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(outsideEscape.defaultPrevented).toBe(false);
    expect(document.activeElement).not.toBe(button);
    await pointer(button, 'pointerout');
    await openHover(button);
    await focus(view.getByRole('button', { name: 'Show all' }));
    const insideEscape = await sendEscape();
    expect(view.queryByRole('dialog')).toBeNull();
    expect(insideEscape.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
    await pointer(button, 'pointerout');
    await openHover(button);
    await pointer(view.getByRole('dialog', { name: 'Checks' }), 'pointerdown');
    expect(view.getByRole('dialog', { name: 'Checks' })).toBeTruthy();
    await pointer(document.body, 'pointerdown');
    expect(view.queryByRole('dialog')).toBeNull();
  });
});
