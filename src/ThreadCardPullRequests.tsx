// A thread's card in the Compact view shows up to two pull request chips (one on a phone) and
// the count of the rest. With GitHub access it takes the menu's order from the first answers,
// with open pull requests first. Anonymously it keeps link order. A thread without pull requests
// shows its worktree's branch instead. The app draws this inside the card's button, so nothing
// here is a control or takes the focus.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
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
import { answerOf, cachedPullRequestAnswer, unlessRefused, usePullRequests } from './queries';
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

const ranksOf = (refs: readonly PullRequestRef[]) =>
  new Map(refs.map((ref, index) => [pullRequestUrl(ref), index]));

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
  const { via, pending, key } = useGitHubAccess();
  const client = useQueryClient();
  const canRead = via !== undefined && !pending;
  // Start from the cache without observing it, so a remount need not show link order first.
  const [initialRanks] = useState(() => {
    if (!canRead) return undefined;
    const answers = pullRequests.map((ref) => cachedPullRequestAnswer(client, ref, key));
    return ranksOf(orderPullRequests(pullRequests, answers));
  });
  const reading = seen && canRead;
  const queries = usePullRequests(reading ? pullRequests : [], {
    ...CHIP_REFETCH,
    refetchOnMount: unlessRefused,
    retryOnMount: unlessRefused,
    refetchOnReconnect: unlessRefused,
  });
  const settledRanks = useRef<ReadonlyMap<string, number>>();
  const ranks = settledRanks.current ?? initialRanks;
  const firstSettle =
    reading && !settledRanks.current && queries.every((query) => query.fetchStatus === 'idle');
  let ordered = pullRequests;
  // Only the first batch of reads can move the chips, not a cache change while offscreen.
  if (firstSettle && queries.some((query) => query.isFetchedAfterMount)) {
    ordered = orderPullRequests(pullRequests, queries.map(answerOf));
  } else if (via !== undefined && ranks) {
    // Keep the order of existing links and put new links last, also after later reads settle.
    const rank = (ref: PullRequestRef) => ranks.get(pullRequestUrl(ref)) ?? ranks.size;
    ordered = [...pullRequests].sort((a, b) => rank(a) - rank(b));
  }
  useEffect(() => {
    if (firstSettle) settledRanks.current = ranksOf(ordered);
  }, [firstSettle, ordered]);
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
