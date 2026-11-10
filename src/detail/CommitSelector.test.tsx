// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Commit } from '../github';
import plugin from '../index';
import { trapOptions } from '../testing/focusTrapStandIn';
import { CommitSelector } from './CommitSelector';

vi.mock('focus-trap-react', async () => ({
  default: (await import('../testing/focusTrapStandIn')).FocusTrapStandIn,
}));

// Commit n was made at minute n, so the highest number is the newest.
const commit = (n: number, headline = `Commit ${n}`): Commit => ({
  sha: `${String(n).padStart(2, '0')}abcdef0123456789`,
  headline,
  author: null,
  authorName: 'Ann',
  committedAt: new Date(Date.UTC(2026, 10, 1, 0, n)).toISOString(),
  url: `https://github.com/mindroom-ai/mindroom-chat/commit/${n}`,
});

// GitHub lists a pull request's commits oldest first.
const COMMITS = Array.from({ length: 12 }, (_, index) => commit(index + 1));

const show = (selected: string | undefined, onCommitChange = vi.fn()) =>
  renderPluginComponent(
    <CommitSelector commits={COMMITS} commit={selected} onCommitChange={onCommitChange} />,
    { id: 'pull-requests', plugin }
  );

const click = (element: HTMLElement) => act(async () => element.click());

const options = (view: Awaited<ReturnType<typeof show>>) =>
  view.getAllByRole('menuitemradio').map((option) => option.textContent);

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('CommitSelector', () => {
  it('the selector lists commits newest first ten at a time', async () => {
    const view = await show(undefined);
    const trigger = view.getByRole('button', { name: 'Diff scope: All commits' });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    await click(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    expect(options(view)).toEqual([
      'All commits',
      ...[12, 11, 10, 9, 8, 7, 6, 5, 4, 3].map(
        (n) => `Commit ${n}${String(n).padStart(2, '0')}abcde`
      ),
    ]);
    const all = view.getByRole('menuitemradio', { name: 'All commits' });
    expect(all.getAttribute('aria-checked')).toBe('true');

    await click(view.getByRole('menuitem', { name: 'Show more (2 left)' }));
    expect(options(view)).toHaveLength(13);
    expect(options(view).slice(-2)).toEqual(['Commit 202abcde', 'Commit 101abcde']);
    // The first commit it brought in takes the focus from the button, which is gone.
    expect(document.activeElement?.textContent).toBe('Commit 202abcde');
    expect(view.queryByRole('menuitem', { name: /Show more/ })).toBeNull();
  });

  it('names the chosen commit and marks it', async () => {
    const view = await show(commit(11).sha);
    const trigger = view.getByRole('button', { name: 'Diff scope: Commit 11' });
    await click(trigger);
    const chosen = view
      .getAllByRole('menuitemradio')
      .filter((option) => option.getAttribute('aria-checked') === 'true');
    expect(chosen.map((option) => option.textContent)).toEqual(['Commit 1111abcde']);
  });

  it('choosing a commit or All commits reports it and closes the menu', async () => {
    const onCommitChange = vi.fn();
    const view = await show(undefined, onCommitChange);
    await click(view.getByRole('button', { name: 'Diff scope: All commits' }));
    await click(view.getByRole('menuitemradio', { name: /^Commit 12/ }));
    expect(onCommitChange).toHaveBeenLastCalledWith(commit(12).sha);
    expect(view.queryByRole('menu')).toBeNull();

    await click(view.getByRole('button', { name: 'Diff scope: All commits' }));
    await click(view.getByRole('menuitemradio', { name: 'All commits' }));
    expect(onCommitChange).toHaveBeenLastCalledWith(undefined);
  });

  it('choosing gives the focus back to the trigger', async () => {
    const view = await show(undefined);
    await click(view.getByRole('button', { name: 'Diff scope: All commits' }));
    // A click focuses the row it chooses, inside the menu's focus trap.
    const row = view.getByRole('menuitemradio', { name: /^Commit 12/ });
    act(() => row.focus());
    await click(row);
    expect(document.activeElement).toBe(view.getByRole('button', { name: /^Diff scope:/ }));
  });

  it('Escape closes the menu and gives the focus back to the trigger', async () => {
    const view = await show(undefined);
    const trigger = view.getByRole('button', { name: 'Diff scope: All commits' });
    await click(trigger);
    act(() => view.getByRole('menuitemradio', { name: 'All commits' }).focus());
    await act(async () => {
      trapOptions().escapeDeactivates?.();
    });
    expect(view.queryByRole('menu')).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });

  it('gives a commit without a headline a name', async () => {
    const view = await renderPluginComponent(
      <CommitSelector commits={[commit(1, '')]} commit={undefined} onCommitChange={vi.fn()} />,
      { id: 'pull-requests', plugin }
    );
    await click(view.getByRole('button', { name: 'Diff scope: All commits' }));
    expect(view.getByRole('menuitemradio', { name: /^Untitled commit/ })).toBeTruthy();
  });
});
