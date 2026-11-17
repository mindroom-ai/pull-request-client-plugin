// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import plugin from '../index';
import { BaseBranch } from './BaseBranch';

vi.mock('focus-trap-react', async () => ({
  default: (await import('../testing/focusTrapStandIn')).FocusTrapStandIn,
}));

const open = async (
  freshness: { behind: number; conflicts: boolean },
  props: {
    onUpdate?: (action: 'update-branch' | 'update-branch-rebase') => void;
    updating?: boolean;
  } = {}
) => {
  const view = await renderPluginComponent(
    <BaseBranch baseBranch="main" headBranch="feature" freshness={freshness} {...props} />,
    { id: 'pull-requests', plugin }
  );
  await click(view.getByRole('button', { name: 'Warnings for main' }));
  return view;
};

const click = (element: HTMLElement) => act(async () => element.click());

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

describe('BaseBranch', () => {
  it('a behind branch offers no update without a way to write', async () => {
    const view = await open({ behind: 2, conflicts: false });
    expect(view.getByText('feature is 2 commits behind main')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Update branch' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Update with rebase' })).toBeNull();
  });

  it('a behind branch offers both updates, and a click starts one', async () => {
    const onUpdate = vi.fn();
    const view = await open({ behind: 2, conflicts: false }, { onUpdate });
    await click(view.getByRole('button', { name: 'Update branch' }));
    expect(onUpdate).toHaveBeenCalledWith('update-branch');
    await click(view.getByRole('button', { name: 'Update with rebase' }));
    expect(onUpdate).toHaveBeenLastCalledWith('update-branch-rebase');
    expect(onUpdate).toHaveBeenCalledTimes(2);
  });

  it('the updates are disabled while an action runs', async () => {
    const onUpdate = vi.fn();
    const view = await open({ behind: 1, conflicts: false }, { onUpdate, updating: true });
    const update = view.getByRole('button', { name: 'Update branch' }) as HTMLButtonElement;
    const rebase = view.getByRole('button', { name: 'Update with rebase' }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    expect(rebase.disabled).toBe(true);
    await click(update);
    expect(onUpdate).not.toHaveBeenCalled();
  });

  it('a conflicting branch offers neither update', async () => {
    const view = await open({ behind: 2, conflicts: true }, { onUpdate: vi.fn() });
    expect(view.getByText('This branch has conflicts that must be resolved')).toBeTruthy();
    expect(view.queryByRole('button', { name: 'Update branch' })).toBeNull();
    expect(view.queryByRole('button', { name: 'Update with rebase' })).toBeNull();
  });
});
