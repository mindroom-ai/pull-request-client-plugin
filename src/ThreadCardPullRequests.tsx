// A thread's pull requests on its card in the Compact view: two chips (one on a phone) and the
// count of the rest, or, for a thread without any, the branch of its worktree. The app draws this
// inside the card's button, so nothing here is a control or takes the focus; the strip under the
// room header has the same pull requests as buttons.
import type { MouseEvent } from 'react';
import type { Room } from 'matrix-js-sdk';
import {
  usePluginTranslation,
  useRoomSidePanel,
  type ThreadCardBadgeProps,
} from '@mindroom/client-sdk/core';
import { useRoomNavigate } from '@mindroom/client-sdk/room';
import { useScreenSize } from '@mindroom/client-sdk/ui';
import { BranchChip } from './BranchChip';
import { pullRequestUrl, type PullRequestRef } from './github';
import { PullRequestChip } from './PullRequestChip';
import { pluginRootStyle } from './theme';
import { useThreadPullRequests } from './threadPullRequests';

// Every thread of the Compact view has a card, most without links: those read only their links
// and worktree. The branch takes no click of its own: a click on it opens the thread.
export function ThreadCardPullRequests({ room, threadId }: ThreadCardBadgeProps) {
  const { pullRequests, repositories, worktree } = useThreadPullRequests(room, threadId);
  if (pullRequests.length === 0) return worktree ? <BranchChip worktree={worktree} /> : null;
  return (
    <CardChips
      room={room}
      threadId={threadId}
      pullRequests={pullRequests}
      showRepository={repositories > 1}
    />
  );
}

function CardChips({
  room,
  threadId,
  pullRequests,
  showRepository,
}: {
  room: Room;
  threadId: string;
  pullRequests: readonly PullRequestRef[];
  showRepository: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const phone = useScreenSize() === 'Mobile';
  const panel = useRoomSidePanel('pull-requests', 'pull-request');
  const { navigateRoomThread } = useRoomNavigate();
  const chips = pullRequests.slice(0, phone ? 1 : 2);
  const more = pullRequests.length - chips.length;
  const moreLabel = t('threadPullRequests.moreLabel', { count: more });
  return (
    <span className="mrpr-thread-card-chips" style={pluginRootStyle()}>
      {chips.map((pullRequest) => (
        <span
          key={pullRequestUrl(pullRequest)}
          className="mrpr-thread-card-chip"
          // A click on a chip opens the thread with the pull request in the side panel, and stops
          // there, so the card does not open the thread a second time. Outside a room's page there
          // is no panel, and the click goes on to the card.
          onClick={
            panel
              ? (event: MouseEvent) => {
                  event.stopPropagation();
                  navigateRoomThread(room.roomId, threadId);
                  panel.open(pullRequest);
                }
              : undefined
          }
        >
          <PullRequestChip pullRequest={pullRequest} showRepository={showRepository} />
        </span>
      ))}
      {more > 0 ? (
        <span className="mrpr-chip-more" role="img" aria-label={moreLabel} title={moreLabel}>
          {t('threadPullRequests.more', { count: more })}
        </span>
      ) : null}
    </span>
  );
}
