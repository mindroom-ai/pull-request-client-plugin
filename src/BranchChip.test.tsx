// @vitest-environment jsdom
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { describe, expect, it } from 'vitest';
import { BranchChip } from './BranchChip';
import plugin from './index';

const show = (path: string, branch: string, repo = '', showRepository = true) =>
  renderPluginComponent(
    <BranchChip worktree={{ path, branch, repo }} showRepository={showRepository} />,
    {
      id: 'pull-requests',
      plugin,
    }
  );

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
    ['redis-sessions', 'redis-sessions'],
  ])('shows the last part of the path %s without a branch', async (path, name) => {
    const view = await show(path, '');
    const chip = view.getByRole('img', { name: `Worktree ${path}` });
    expect(chip.textContent).toBe(name);
    expect(chip.getAttribute('title')).toBe(`Worktree ${path}`);
  });

  it("shows the repository's name before the branch's, and names it", async () => {
    const path = '/srv/mindroom-chat-worktrees/redis-sessions';
    const view = await show(path, 'redis-sessions', 'mindroom-chat');
    const label = `Worktree ${path}, repository mindroom-chat, branch redis-sessions`;
    const chip = view.getByRole('img', { name: label });
    expect(chip.getAttribute('title')).toBe(label);
    expect(
      [...chip.querySelectorAll('.mrpr-branch-chip-names > span')].map((part) => part.textContent)
    ).toEqual(['mindroom-chat', 'redis-sessions']);
    expect(chip.querySelector('.mrpr-chip-repo')?.textContent).toBe('mindroom-chat');
  });

  it("shows the repository's name before the last part of the path without a branch", async () => {
    const view = await show('mindroom-chat-worktrees/redis-sessions', '', 'mindroom-chat');
    const label = 'Worktree mindroom-chat-worktrees/redis-sessions, repository mindroom-chat';
    const chip = view.getByRole('img', { name: label });
    expect(
      [...chip.querySelectorAll('.mrpr-branch-chip-names > span')].map((part) => part.textContent)
    ).toEqual(['mindroom-chat', 'redis-sessions']);
  });

  it('names the repository without drawing it in a room with one repository', async () => {
    const path = '/srv/mindroom-chat-worktrees/redis-sessions';
    const view = await show(path, 'redis-sessions', 'mindroom-chat', false);
    const chip = view.getByRole('img', {
      name: `Worktree ${path}, repository mindroom-chat, branch redis-sessions`,
    });
    expect(chip.textContent).toBe('redis-sessions');
    expect(chip.querySelector('.mrpr-chip-repo')).toBeNull();
  });

  it('shows the last part of an absolute path without a branch', async () => {
    const view = await show('/srv/worktrees/redis-sessions', '');
    const chip = view.getByRole('img', { name: 'Worktree /srv/worktrees/redis-sessions' });
    expect(chip.textContent).toBe('redis-sessions');
  });

  it('sets the variables it draws with', async () => {
    const view = await show('worktrees/redis-sessions', 'redis-sessions');
    const chip = view.getByRole('img', { name: /^Worktree / });
    expect(chip.style.getPropertyValue('--pr-muted')).not.toBe('');
  });
});
