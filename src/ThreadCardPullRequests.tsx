// A thread's card in the Compact view shows up to two pull request chips (one on a phone) in
// the open thread's menu order, with open pull requests first, and the count of the rest. A thread
// without pull requests shows its worktree's branch instead. The app draws this inside the card's
// button, so nothing here is a control or takes the focus.
import { useState, type MouseEvent } from 'react';
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
import { CHIP_REFETCH, PullRequestChip, useOnScreenOnce } from './PullRequestChip';
import { answerOf, unlessRefused, usePullRequests } from './queries';
import { pluginRootStyle } from './theme';
import { orderPullRequests } from './ThreadDetails';
import { useThreadPullRequests } from './threadPullRequests';
import { RoomGitHub, useGitHubAccess } from './token';

// Every thread of the Compact view has a card, most without links: those read only their links
// and worktree. The branch takes no click of its own: a click on it opens the thread.
export function ThreadCardPullRequests({ room, threadId }: ThreadCardBadgeProps) {
  const { pullRequests, repositories, worktree, showWorktreeRepository } = useThreadPullRequests(
    room,
    threadId
  );
  if (pullRequests.length === 0) {
    return worktree ? (
      <BranchChip worktree={worktree} showRepository={showWorktreeRepository} />
    ) : null;
  }
  return (
    <RoomGitHub roomId={room.roomId}>
      <CardChips
        room={room}
        threadId={threadId}
        pullRequests={pullRequests}
        showRepository={repositories > 1}
      />
    </RoomGitHub>
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
  const [element, setElement] = useState<HTMLElement | null>(null);
  const seen = useOnScreenOnce(element);
  const { via } = useGitHubAccess();
  // Anonymously, use cached answers for the order and leave the hourly limit for the shown chips.
  const cacheOnly = via === undefined;
  const queries = usePullRequests(seen ? pullRequests : [], {
    ...CHIP_REFETCH,
    ...(cacheOnly && { enabled: false }),
    refetchOnMount: unlessRefused,
    retryOnMount: false,
  });
  // Keep link order while summaries load, so partial answers do not move the chips.
  const ordered =
    !seen || queries.some((query) => query.isLoading)
      ? pullRequests
      : orderPullRequests(pullRequests, queries.map(answerOf));
  const chips = ordered.slice(0, phone ? 1 : 2);
  const more = pullRequests.length - chips.length;
  const moreLabel = t('threadPullRequests.moreLabel', { count: more });
  return (
    <span ref={setElement} className="mrpr-thread-card-chips" style={pluginRootStyle()}>
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
          <PullRequestChip
            pullRequest={pullRequest}
            showRepository={showRepository}
            opensPanel={Boolean(panel)}
          />
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
