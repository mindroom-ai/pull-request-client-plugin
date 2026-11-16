// A thread's worktree in one line: the branch icon, the repository's name in a room that works on
// several repositories, and the branch's name, or the last part of the worktree's path when it has
// no branch. A span wherever it sits: on a thread's card a click on it opens the thread, as
// anywhere else on the card, and under the room header it is only text.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { GitBranch } from 'lucide-react';
import { pluginRootStyle } from './theme';
import type { ThreadWorktree } from './threadPullRequests';

export function BranchChip({
  worktree,
  showRepository,
}: {
  worktree: ThreadWorktree;
  /** Whether the repository's name is drawn; the chip's label names it either way. */
  showRepository: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const { path, branch, repo } = worktree;
  // The path's last part, also of a path that ends in a slash.
  const name = branch || (path.split('/').filter(Boolean).pop() ?? path);
  const key = `branch.label${repo ? 'WithRepository' : ''}${
    branch ? '' : 'WithoutBranch'
  }` as const;
  const label = t(key, { path, branch, repo });
  // The chip is drawn outside the card and the panel, so it sets the variables it draws with.
  return (
    <span
      className="mrpr-chip mrpr-branch-chip"
      style={pluginRootStyle()}
      role="img"
      aria-label={label}
      title={label}
    >
      <GitBranch aria-hidden className="mrpr-icon mrpr-branch-chip-icon" />
      {repo && showRepository ? <span className="mrpr-chip-repo">{repo}</span> : null}
      <span className="mrpr-branch-chip-name">{name}</span>
    </span>
  );
}
