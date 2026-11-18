// The pull requests of the open thread, in its banner: one button with their count that opens a
// menu of them, as T3 Code's thread details do. Each item is the pull request's details row and
// opens it in the side panel (the one the open panel shows is current), or on GitHub where the page
// has no panel; the thread's worktree comes last, as an item that does nothing. The button's icon
// and tone are its pull requests' state together, as T3 Code's thread badge: it asks GitHub for
// each pull request no surface has loaded yet (none for checks), once, refusals included.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import FocusTrap from 'focus-trap-react';
import { IconButton, type RectCords } from 'folds';
import { GitBranch, GitPullRequestArrow } from 'lucide-react';
import {
  usePluginTranslation,
  useRoomSidePanel,
  type ThreadHeaderSlotComponent,
} from '@mindroom/client-sdk/core';
import { IconTooltip, Menu, PopOut } from '@mindroom/client-sdk/ui';
import { pullRequestUrl, type PullRequestRef } from './github';
import {
  combinedPullRequestState,
  PULL_REQUEST_STATE_PRESENTATION,
  resolvePullRequestState,
} from './presentation';
import { usePullRequests } from './queries';
import { useShownPullRequest } from './shownPullRequest';
import { ANSWERED_ONLY, Details } from './ThreadDetails';
import { useThreadPullRequests, type ThreadWorktree } from './threadPullRequests';
import { pluginRootStyle } from './theme';
import { RoomGitHub } from './token';

/** Whether `a` and `b` name one pull request; GitHub's owner and repository names ignore case. */
const samePullRequest = (a: PullRequestRef, b: PullRequestRef) =>
  a.number === b.number &&
  a.owner.toLowerCase() === b.owner.toLowerCase() &&
  a.repo.toLowerCase() === b.repo.toLowerCase();

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

function PullRequestsMenu({
  roomId,
  pullRequests,
  worktree,
}: {
  roomId: string;
  pullRequests: readonly PullRequestRef[];
  worktree: ThreadWorktree | undefined;
}) {
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
  const queries = usePullRequests(pullRequests, ANSWERED_ONLY);
  // A refetch GitHub refused keeps the answer before beside the error: that one counts no more.
  const answered = queries.flatMap((query) =>
    query.status === 'success' ? [resolvePullRequestState(query.data).key] : []
  );
  const combined = combinedPullRequestState(answered);
  // Until every answer is in, only an open one already settles it: the tone never changes once shown.
  const loading = queries.some((query) => query.status === 'pending');
  const state = loading && combined !== 'open' ? undefined : combined;
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
    if (!panel) {
      return (
        <a
          role="menuitem"
          className="mrpr-thread-menu-item"
          href={pullRequestUrl(pullRequest)}
          target="_blank"
          rel="noreferrer"
          onClick={choose}
        >
          {rows}
        </a>
      );
    }
    return (
      <button
        type="button"
        role="menuitem"
        className="mrpr-thread-menu-item"
        aria-current={current && samePullRequest(current, pullRequest) ? 'true' : undefined}
        onClick={() => {
          choose();
          panel.open(pullRequest);
        }}
      >
        {rows}
      </button>
    );
  };

  return (
    <>
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
              />
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}
