// The pull requests of the open thread, in its banner: one button with their count that opens a
// menu of them, as T3 Code's thread details do. Each item is the pull request's details row and
// opens it in the side panel (the one the open panel shows is current), or on GitHub where the page
// has no panel; the thread's worktree comes last, as an item that does nothing. The button's icon
// and tone are its pull requests' state together, as T3 Code's thread badge. With a token or the
// GitHub account connected in MindRoom it asks GitHub for each pull request no surface has loaded
// yet (none for checks), a refusal once, and reads an answer again once it is two minutes old: when
// the page shows again, every five minutes while the pull request is open or a draft, and when the
// menu opens (`useBannerRefetch`); without either it asks nothing and goes by what the chips and the
// menu's rows read.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import FocusTrap from 'focus-trap-react';
import { useQueryClient, type Query } from '@tanstack/react-query';
import { IconButton, type RectCords } from 'folds';
import { GitBranch, GitPullRequestArrow } from 'lucide-react';
import {
  usePluginTranslation,
  useRoomSidePanel,
  type ThreadHeaderSlotComponent,
} from '@mindroom/client-sdk/core';
import { IconTooltip, Menu, PopOut } from '@mindroom/client-sdk/ui';
import type { PullRequestRef } from './github';
import {
  combinedPullRequestState,
  PULL_REQUEST_STATE_PRESENTATION,
  resolvePullRequestState,
  type PullRequestStateKey,
} from './presentation';
import { answerOf, pullRequestKey, STALE_TIME, unlessRefused, usePullRequests } from './queries';
import { useShownPullRequest } from './shownPullRequest';
import { Details, PullRequestMenuItem, useBannerRefetch } from './ThreadDetails';
import { useThreadPullRequests, type ThreadWorktree } from './threadPullRequests';
import { pluginRootStyle } from './theme';
import { RoomGitHub, useGitHubAccess } from './token';

export const ThreadPullRequestsButton: ThreadHeaderSlotComponent = ({ room, threadId }) => {
  const { pullRequests, worktree } = useThreadPullRequests(room, threadId);
  // A thread can lose its last link or its worktree while it is open: the button then goes, and
  // with it whether its menu was open, so the next link shows it closed.
  if (pullRequests.length === 0 && !worktree) return null;
  return (
    <RoomGitHub roomId={room.roomId}>
      <PullRequestsMenu roomId={room.roomId} pullRequests={pullRequests} worktree={worktree} />
    </RoomGitHub>
  );
};

/**
 * The state of the pull requests `pullRequests` together, once it is known: until every answer is
 * in, only an open one already settles it, so the tone never changes once shown.
 */
function useCombinedState(pullRequests: readonly PullRequestRef[]) {
  // Without a token or MindRoom, GitHub allows 60 requests an hour: the button then asks for
  // nothing and goes by what the chips and the menu's rows read.
  const access = useGitHubAccess();
  const anonymous = access.via === undefined;
  const queries = usePullRequests(pullRequests, {
    ...useBannerRefetch(true),
    ...(anonymous && { enabled: false }),
  });
  // TanStack hears the page shown again, not its window focused while shown: that reads here.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (anonymous) return undefined;
    const keys = pullRequests.map((ref) => JSON.stringify([...pullRequestKey(ref), access.key]));
    const predicate = (query: Query) =>
      keys.includes(query.queryHash) && unlessRefused(query) && query.isStaleByTime(STALE_TIME);
    const focus = () => void queryClient.refetchQueries({ predicate }, { cancelRefetch: false });
    window.addEventListener('focus', focus);
    return () => window.removeEventListener('focus', focus);
  }, [access.key, anonymous, pullRequests, queryClient]);
  // A refetch GitHub refused keeps the answer before beside the error: that one counts no more.
  // One that failed (no answer, an error of GitHub's, its rate limit) still does.
  const answered = queries.flatMap((query) => {
    const answer = answerOf(query);
    return answer ? [resolvePullRequestState(answer).key] : [];
  });
  const combined = combinedPullRequestState(answered);
  const loading = queries.some((query) => query.status === 'pending');
  // Until the room's MindRoom server says whether GitHub is connected there, what was read
  // anonymously may be what the connection sees no more (a private pull request).
  if (access.pending) return undefined;
  return loading && combined !== 'open' ? undefined : combined;
}

/** Reports `useCombinedState` to `onState`, and undefined once it goes. */
function CombinedState({
  pullRequests,
  onState,
}: {
  pullRequests: readonly PullRequestRef[];
  onState: (state: PullRequestStateKey | undefined) => void;
}) {
  const state = useCombinedState(pullRequests);
  useEffect(() => onState(state), [onState, state]);
  useEffect(() => () => onState(undefined), [onState]);
  return null;
}

function PullRequestsMenu({
  roomId,
  pullRequests,
  worktree,
}: {
  roomId: string;
  pullRequests: readonly PullRequestRef[];
  worktree: ThreadWorktree | undefined;
}) {
  // Read beside the button, only with pull requests: a thread with only a worktree asks nothing,
  // and gaining or losing its first link keeps the button and its menu as they are.
  const [read, setState] = useState<PullRequestStateKey>();
  const state = pullRequests.length > 0 ? read : undefined;
  const t = usePluginTranslation('pull-requests');
  const panel = useRoomSidePanel('pull-requests', 'pull-request');
  const shown = useShownPullRequest(roomId);
  const [anchor, setAnchor] = useState<RectCords>();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Set when a choice, Escape or a press over the button closes the menu, which then gives the
  // focus back to its button once the menu's focus trap is gone. A press elsewhere leaves it be.
  const refocus = useRef(false);
  useEffect(() => {
    if (anchor !== undefined || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [anchor]);
  const count = pullRequests.length;
  const presentation = state && PULL_REQUEST_STATE_PRESENTATION[state];
  const label =
    count === 0
      ? t('details.worktree')
      : state
      ? t('threadPullRequests.buttonWithState', { count, state: t(`state.${state}`) })
      : t('threadPullRequests.button', { count });
  const Icon = count === 0 ? GitBranch : presentation?.Icon ?? GitPullRequestArrow;
  const current = panel?.isOpen ? shown : undefined;
  // The open menu's layer covers the page, the button too: a press over the button closes the
  // menu as any press outside it does, and gives the button back the focus a row may have had.
  const closeOutside = (event: Event) => {
    const box = buttonRef.current?.getBoundingClientRect();
    refocus.current =
      event instanceof globalThis.MouseEvent &&
      !!box &&
      event.clientX >= box.left &&
      event.clientX <= box.right &&
      event.clientY >= box.top &&
      event.clientY <= box.bottom;
    // The press would then focus what it hit, the layer, gone by then: the focus would leave.
    if (refocus.current) event.preventDefault();
    setAnchor(undefined);
    return true;
  };
  const choose = () => {
    refocus.current = true;
    setAnchor(undefined);
  };
  const item = (pullRequest: PullRequestRef | undefined, rows: ReactNode) => {
    // The worktree: an item a reader hears among the others, which does nothing. It takes the
    // focus as the others do, so a menu of it alone still has something its focus trap can hold.
    if (pullRequest === undefined) {
      return (
        <div
          role="menuitem"
          aria-disabled="true"
          tabIndex={0}
          className="mrpr-thread-menu-item mrpr-thread-menu-worktree"
        >
          {rows}
        </div>
      );
    }
    return (
      <PullRequestMenuItem
        pullRequest={pullRequest}
        panel={panel}
        current={current}
        onClose={choose}
      >
        {rows}
      </PullRequestMenuItem>
    );
  };

  return (
    <>
      {pullRequests.length > 0 ? (
        <CombinedState pullRequests={pullRequests} onState={setState} />
      ) : null}
      <IconTooltip label={label} hidden={anchor !== undefined}>
        {(triggerRef) => (
          // As the banner draws its own buttons: folds' button without a fill (styles.css sizes it).
          <IconButton
            ref={(node: HTMLButtonElement | null) => {
              triggerRef(node);
              buttonRef.current = node;
            }}
            className="mrpr-thread-button"
            variant="SurfaceVariant"
            fill="None"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={anchor !== undefined}
            onClick={(event: MouseEvent<HTMLButtonElement>) =>
              setAnchor(event.currentTarget.getBoundingClientRect())
            }
          >
            <Icon
              aria-hidden
              className={`mrpr-thread-button-icon ${presentation?.toneClassName ?? ''}`.trim()}
              style={presentation && pluginRootStyle()}
            />
            {count > 1 ? <span className="mrpr-thread-button-count">{count}</span> : null}
          </IconButton>
        )}
      </IconTooltip>
      <PopOut
        anchor={anchor}
        position="Bottom"
        align="End"
        offset={4}
        content={
          <FocusTrap
            focusTrapOptions={{
              initialFocus: false,
              returnFocusOnDeactivate: false,
              clickOutsideDeactivates: closeOutside,
              escapeDeactivates: () => {
                refocus.current = true;
                setAnchor(undefined);
                return true;
              },
            }}
          >
            <Menu role="menu" aria-label={label} className="mrpr-thread-menu">
              <Details
                pullRequests={pullRequests}
                worktree={worktree}
                item={item}
                className="mrpr-thread-menu-rows"
                inBanner
              />
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}
