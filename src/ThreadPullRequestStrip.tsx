// The pull requests of the thread the room's page shows, under the room header: the branch of its
// worktree as text first, then a chip for each that opens it in the side panel, the one the open
// panel shows marked as pressed.
import type { Room } from 'matrix-js-sdk';
import { usePluginTranslation, useRoomSidePanel } from '@mindroom/client-sdk/core';
import { useShownThread } from '@mindroom/client-sdk/room';
import { BranchChip } from './BranchChip';
import { pullRequestUrl, type PullRequestRef } from './github';
import { PullRequestChip } from './PullRequestChip';
import { useShownPullRequest } from './shownPullRequest';
import { useThreadPullRequests } from './threadPullRequests';

/** Whether `a` and `b` name one pull request; GitHub's owner and repository names ignore case. */
const samePullRequest = (a: PullRequestRef, b: PullRequestRef) =>
  a.number === b.number &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase();

export function ThreadPullRequestStrip({ room }: { room: Room }) {
  const t = usePluginTranslation('pull-requests');
  const threadId = useShownThread();
  const { pullRequests, repositories, worktree, showWorktreeRepository } = useThreadPullRequests(
    room,
    threadId
  );
  const panel = useRoomSidePanel('pull-requests', 'pull-request');
  const shown = useShownPullRequest(room.roomId);
  if (pullRequests.length === 0 && worktree === undefined) return null;
  const selected = panel?.isOpen ? shown : undefined;
  return (
    <div className="mrpr-thread-strip" role="group" aria-label={t('threadPullRequests.strip')}>
      {worktree ? <BranchChip worktree={worktree} showRepository={showWorktreeRepository} /> : null}
      {pullRequests.map((pullRequest) => (
        <PullRequestChip
          key={pullRequestUrl(pullRequest)}
          pullRequest={pullRequest}
          showRepository={repositories > 1}
          selected={selected !== undefined && samePullRequest(selected, pullRequest)}
          onSelect={panel ? () => panel.open(pullRequest) : undefined}
        />
      ))}
    </div>
  );
}
