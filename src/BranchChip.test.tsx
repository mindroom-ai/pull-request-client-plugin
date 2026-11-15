// @vitest-environment jsdom
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { describe, expect, it } from 'vitest';
import { BranchChip } from './BranchChip';
import plugin from './index';

const show = (path: string, branch: string) =>
  renderPluginComponent(<BranchChip worktree={{ path, branch }} />, {
    id: 'pull-requests',
    plugin,
  });

describe('BranchChip', () => {
  it("shows the branch icon and the branch's name, and names the path and the branch", async () => {
    const view = await show('worktrees/redis-sessions', 'redis-sessions');
    const label = 'Worktree worktrees/redis-sessions, branch redis-sessions';
    const chip = view.getByRole('img', { name: label });
    expect(chip.tagName).toBe('SPAN');
    expect(chip.textContent).toBe('redis-sessions');
    expect(chip.getAttribute('title')).toBe(label);
    expect(chip.querySelector('svg')?.getAttribute('aria-hidden')).toBe('true');
    expect(view.container.querySelector('button, a, [tabindex]')).toBeNull();
  });

  it.each([
    ['worktrees/redis-sessions', 'redis-sessions'],
    ['worktrees/redis-sessions/', 'redis-sessions'],
    ['redis-sessions', 'redis-sessions'],
  ])('shows the last part of the path %s without a branch', async (path, name) => {
    const view = await show(path, '');
    const chip = view.getByRole('img', { name: `Worktree ${path}` });
    expect(chip.textContent).toBe(name);
    expect(chip.getAttribute('title')).toBe(`Worktree ${path}`);
  });

  it('sets the variables it draws with', async () => {
    const view = await show('worktrees/redis-sessions', 'redis-sessions');
    const chip = view.getByRole('img', { name: /^Worktree / });
    expect(chip.style.getPropertyValue('--pr-muted')).not.toBe('');
  });
});
