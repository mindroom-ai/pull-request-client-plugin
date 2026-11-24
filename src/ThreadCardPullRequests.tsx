// A thread's card in the Compact view shows up to two pull request chips (one on a phone) and
// the count of the rest. With GitHub access the chips follow the menu's order, with open pull
// requests first. Anonymously they keep link order. A thread without pull requests shows its
// worktree's branch instead. The app draws this inside the card's button, so nothing here is a
// control or takes the focus.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
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
  const { via, pending } = useGitHubAccess();
  const reading = seen && via !== undefined;
  const queries = usePullRequests(pullRequests, {
    ...CHIP_REFETCH,
    enabled: reading ? unlessRefused : false,
    refetchOnMount: unlessRefused,
    retryOnMount: unlessRefused,
    refetchOnReconnect: unlessRefused,
  });
  const settledRanks = useRef<ReadonlyMap<string, number> | undefined>(undefined);
  const previous = settledRanks.current;
  const idle = queries.every((query) => query.fetchStatus === 'idle');
  const answered = queries.every((query) => !query.isPending);
  const settled = via !== undefined && !pending && answered && (!previous || idle);
  let ordered = pullRequests;
  if (settled) {
    ordered = orderPullRequests(pullRequests, queries.map(answerOf));
  } else if (via !== undefined && previous) {
    // Keep the last settled order among the current links and leave new links at the end.
    const rank = (ref: PullRequestRef) => previous.get(pullRequestUrl(ref)) ?? previous.size;
    ordered = [...pullRequests].sort((a, b) => rank(a) - rank(b));
  }
  const settledUrls = settled ? ordered.map(pullRequestUrl).join('\n') : undefined;
  useEffect(() => {
    if (settledUrls !== undefined) {
      settledRanks.current = new Map(settledUrls.split('\n').map((url, index) => [url, index]));
    }
  }, [settledUrls]);
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
