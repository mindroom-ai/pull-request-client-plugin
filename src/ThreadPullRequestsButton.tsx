// The pull requests of the open thread, in its banner: one button with their count that opens a
// menu of them, as T3 Code's thread details do. Each item is the pull request's details row and
// opens it in the side panel (the one the open panel shows is current), or on GitHub where the page
// has no panel; the thread's worktree comes last, as an item that does nothing. Closed, the button
// asks GitHub nothing: the rows ask only for a pull request no surface has loaded yet.
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
import { useShownPullRequest } from './shownPullRequest';
import { Details } from './ThreadDetails';
import { useThreadPullRequests, type ThreadWorktree } from './threadPullRequests';
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
  return <PullRequestsMenu roomId={room.roomId} pullRequests={pullRequests} worktree={worktree} />;
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
  // Set when a choice, Escape or the button closes the menu, which then gives the focus back to
  // its button once the menu's focus trap is gone. A click outside leaves the focus where it went.
  const refocus = useRef(false);
  useEffect(() => {
    if (anchor !== undefined || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [anchor]);
  const count = pullRequests.length;
  const label = count > 0 ? t('threadPullRequests.button', { count }) : t('details.worktree');
  const current = panel?.isOpen ? shown : undefined;
  // A press on the button itself is the button's: its click closes the open menu, so the trap
  // neither closes it on the mousedown (the click would open it again) nor swallows that click.
  const onButton = (event: Event) =>
    event.target instanceof Node && !!buttonRef.current?.contains(event.target);
  const closeOutside = (event: Event) => {
    if (onButton(event)) return false;
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
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              // Closing, the focus may be on a row the menu takes with it: it comes back here.
              refocus.current = anchor !== undefined;
              setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect());
            }}
          >
            {count > 0 ? (
              <GitPullRequestArrow aria-hidden className="mrpr-thread-button-icon" />
            ) : (
              <GitBranch aria-hidden className="mrpr-thread-button-icon" />
            )}
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
              allowOutsideClick: onButton,
              escapeDeactivates: () => {
                refocus.current = true;
                setAnchor(undefined);
                return true;
              },
            }}
          >
            <Menu role="menu" aria-label={label} className="mrpr-thread-menu">
              <RoomGitHub roomId={roomId}>
                <Details
                  pullRequests={pullRequests}
                  worktree={worktree}
                  item={item}
                  className="mrpr-thread-menu-rows"
                />
              </RoomGitHub>
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}
