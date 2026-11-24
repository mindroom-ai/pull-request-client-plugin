// A thread's details, in the hover card of its card in the Compact view and as the first group of
// its menu: each of its pull requests, also those past the two its card shows, open ones first, then
// drafts, closed and merged ones, each newest activity first (as GitHub answers), then its worktree.
// Hover cards draw them as read-only rows, with no control or focus; interactive surfaces pass
// `onClose`, so each pull request renders as a menu item opening the panel (or GitHub). A pull
// request asks GitHub through the chips' own queries, so its chip's answer is already there. A pull
// request on the worktree's branch says so, and the worktree then leaves its branch out. The open
// thread's pull requests menu draws the same rows, each pull request as one of its items, and so
// does the hover card of a pull request link in a message, for that pull request.
import { Fragment, useMemo, type ReactNode } from 'react';
import {
  usePluginTranslation,
  useRoomSidePanel,
  type MessageLinkHoverCardProps,
  type ThreadDetailProps,
} from '@mindroom/client-sdk/core';
import { Folder, GitBranch, GitPullRequestArrow } from 'lucide-react';
import {
  parsePullRequestUrl,
  pullRequestUrl,
  samePullRequest,
  type PullRequest,
  type PullRequestRef,
} from './github';
import { middleTruncate } from './middleTruncate';
import {
  PullRequestDiffStat,
  PullRequestMetaLine,
  pullRequestChecksStatePresentation,
  RelativeTime,
  resolvePullRequestState,
  type PullRequestStateKey,
} from './presentation';
import { usePullRequestStatus } from './pullRequestStatus';
import {
  answerOf,
  NO_FOCUS_REFETCH,
  unlessRefused,
  usePullRequests,
  type RefetchOptions,
} from './queries';
import { useShownPullRequest } from './shownPullRequest';
import { pluginRootStyle } from './theme';
import { useThreadPullRequests, type ThreadWorktree } from './threadPullRequests';
import { RoomGitHub, useGitHubAccess } from './token';

/** The most code points a worktree's path shows, shortened in its middle so its leaf stays. */
const PATH_MAX = 40;

// A hover shows what GitHub answered a chip, however old: only a pull request it has no answer for
// yet is asked for, so moving the pointer over cards spends none of the hourly limit. A refusal is an
// answer too: without `retryOnMount` every hover would ask again for a pull request GitHub refused,
// and the network coming back asks nothing either. (An answer the cache dropped is asked for again.)
export const ANSWERED_ONLY = {
  ...NO_FOCUS_REFETCH,
  refetchOnMount: false,
  retryOnMount: false,
  refetchOnReconnect: false,
};

// How often the banner's button reads again a pull request that is still open or a draft.
const UNSETTLED_INTERVAL = 5 * 60_000;
const STALE_ON_MOUNT: RefetchOptions = {
  ...ANSWERED_ONLY,
  refetchOnMount: unlessRefused,
  refetchOnReconnect: unlessRefused,
};
const FOLLOWING: RefetchOptions = {
  ...STALE_ON_MOUNT,
  refetchOnWindowFocus: unlessRefused,
  refetchInterval: (query) =>
    unlessRefused(query) && (query.state.data as PullRequest | undefined)?.state === 'open'
      ? UNSETTLED_INTERVAL
      : false,
  refetchIntervalInBackground: false,
};

/**
 * How the open thread's banner reads its pull requests: `following` for its button, which stays
 * mounted as long as the thread shows, else for its menu's rows. With a token or MindRoom's
 * connection GitHub allows 5,000 requests an hour, and a token's own read of a pull request
 * unchanged since, answered with a 304, costs none (one through MindRoom is an ordinary request):
 * the menu then reads an answer older than two minutes again when it opens, and the
 * button also when the page shows again (the tab, or the app resumed) and every five minutes while
 * it shows, until the pull request is merged or closed. Anonymously, `ANSWERED_ONLY`, as a hover.
 */
export function useBannerRefetch(following: boolean): RefetchOptions {
  if (useGitHubAccess().via === undefined) return ANSWERED_ONLY;
  return following ? FOLLOWING : STALE_ON_MOUNT;
}

const STATE_RANK: Record<PullRequestStateKey, number> = { open: 0, draft: 1, closed: 2, merged: 3 };

/**
 * `refs` open first, then drafts, closed and merged ones, each newest activity first; those without
 * an answer in `answers` (alongside) come last. Ties keep their order.
 */
export function orderPullRequests<T>(
  refs: readonly T[],
  answers: readonly (Pick<PullRequest, 'state' | 'draft' | 'updatedAt'> | undefined)[]
): T[] {
  const rank = (index: number) => {
    const answer = answers[index];
    return answer ? STATE_RANK[resolvePullRequestState(answer).key] : 4;
  };
  const time = (index: number) => Date.parse(answers[index]?.updatedAt ?? '') || 0;
  return refs
    .map((_ref, index) => index)
    .sort((a, b) => rank(a) - rank(b) || time(b) - time(a))
    .map((index) => refs[index] as T);
}

export function ThreadDetails({ room, threadId, onClose }: ThreadDetailProps) {
  const { pullRequests, worktree } = useThreadPullRequests(room, threadId);
  // A thread can lose its last link or its worktree while a surface shows it: it then draws none.
  if (pullRequests.length === 0 && !worktree) return null;
  return (
    <RoomGitHub roomId={room.roomId}>
      {onClose ? (
        <InteractiveDetails
          roomId={room.roomId}
          pullRequests={pullRequests}
          worktree={worktree}
          onClose={onClose}
        />
      ) : (
        <Details pullRequests={pullRequests} worktree={worktree} />
      )}
    </RoomGitHub>
  );
}

/**
 * One pull request row in a menu: opens the room side panel when available (marking the currently
 * shown pull request with `aria-current`), or falls back to an external GitHub link.
 */
export function PullRequestMenuItem({
  pullRequest,
  panel,
  current,
  onClose,
  className,
  children,
}: {
  pullRequest: PullRequestRef;
  panel: ReturnType<typeof useRoomSidePanel>;
  current: PullRequestRef | undefined;
  onClose: () => void;
  className?: string;
  children: ReactNode;
}) {
  const classes = className ? `mrpr-thread-menu-item ${className}` : 'mrpr-thread-menu-item';
  if (!panel) {
    return (
      <a
        role="menuitem"
        className={classes}
        href={pullRequestUrl(pullRequest)}
        target="_blank"
        rel="noreferrer"
        onClick={onClose}
      >
        {children}
      </a>
    );
  }
  return (
    <button
      type="button"
      role="menuitem"
      className={classes}
      aria-current={current && samePullRequest(current, pullRequest) ? 'true' : undefined}
      onClick={() => {
        onClose();
        panel.open(pullRequest);
      }}
    >
      {children}
    </button>
  );
}

function InteractiveDetails({
  roomId,
  pullRequests,
  worktree,
  onClose,
}: {
  roomId: string;
  pullRequests: readonly PullRequestRef[];
  worktree: ThreadWorktree | undefined;
  onClose: () => void;
}) {
  const panel = useRoomSidePanel('pull-requests', 'pull-request');
  const shown = useShownPullRequest(roomId);
  const current = panel?.isOpen ? shown : undefined;
  return (
    <Details
      pullRequests={pullRequests}
      worktree={worktree}
      className="mrpr-details-interactive"
      item={(pullRequest, rows) =>
        pullRequest === undefined ? (
          rows
        ) : (
          <PullRequestMenuItem
            pullRequest={pullRequest}
            panel={panel}
            current={current}
            onClose={onClose}
            className="mrpr-details-menu-item"
          >
            {rows}
          </PullRequestMenuItem>
        )
      }
    />
  );
}

/** The hover card of a pull request link: its rows in the banner's menu, read as the menu reads them. */
export function PullRequestLinkHoverCard({ href, roomId }: MessageLinkHoverCardProps) {
  const pullRequests = useMemo(() => {
    const pullRequest = parsePullRequestUrl(new URL(href));
    return pullRequest ? [pullRequest] : [];
  }, [href]);
  return (
    <RoomGitHub roomId={roomId}>
      <Details pullRequests={pullRequests} worktree={undefined} inBanner />
    </RoomGitHub>
  );
}

/**
 * The rows, inside `RoomGitHub`, so the heads are read with the room's access, as each chip reads
 * them. `item` wraps each pull request's and the worktree's rows (`pullRequest` undefined), as the
 * menu's items; `className` joins the root's. `inBanner`, the open thread's menu (and a link's
 * hover card), reads stale
 * answers again (`useBannerRefetch`); elsewhere they are a hover's, `ANSWERED_ONLY`.
 */
export function Details({
  pullRequests,
  worktree,
  item = (_pullRequest, rows) => rows,
  className,
  inBanner = false,
}: {
  pullRequests: readonly PullRequestRef[];
  worktree: ThreadWorktree | undefined;
  item?: (pullRequest: PullRequestRef | undefined, rows: ReactNode) => ReactNode;
  className?: string;
  inBanner?: boolean;
}) {
  const bannerRefetch = useBannerRefetch(false);
  const refetch = inBanner ? bannerRefetch : ANSWERED_ONLY;
  // The same queries as each pull request's below, so they ask GitHub nothing more.
  const queries = usePullRequests(pullRequests, refetch);
  const heads = queries.map((query) => (inBanner ? answerOf(query) : query.data)?.headRef);
  // A refetch GitHub refused keeps the answer before beside the error: as the banner's button, the
  // order takes it for no answer; one that failed (no answer, an error of GitHub's) keeps it.
  const answers = queries.map(answerOf);
  return (
    <div
      className={className ? `mrpr-root mrpr-details ${className}` : 'mrpr-root mrpr-details'}
      style={pluginRootStyle()}
    >
      {orderPullRequests(pullRequests, answers).map((pullRequest) => (
        <Fragment key={pullRequestUrl(pullRequest)}>
          {item(
            pullRequest,
            <PullRequestDetails
              pullRequest={pullRequest}
              worktreeBranch={worktree?.branch}
              refetch={refetch}
              inBanner={inBanner}
            />
          )}
        </Fragment>
      ))}
      {worktree
        ? item(
            undefined,
            <WorktreeDetails worktree={worktree} showBranch={!heads.includes(worktree.branch)} />
          )
        : null}
    </div>
  );
}

function PullRequestDetails({
  pullRequest,
  worktreeBranch,
  refetch,
  inBanner,
}: {
  pullRequest: PullRequestRef;
  worktreeBranch: string | undefined;
  refetch: RefetchOptions;
  inBanner: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  // The very ref the chip asks with: the same queries, so a chip that loaded leaves nothing to ask.
  const { pr, state, checks } = usePullRequestStatus(pullRequest, refetch, inBanner);
  const mark = checks && pullRequestChecksStatePresentation(checks);
  const StateIcon = state?.Icon ?? GitPullRequestArrow;
  return (
    <div className="mrpr-details-pull-request">
      <div className="mrpr-details-row">
        {/* Until GitHub answers, or when it refuses, the plain icon in the draft's tone. */}
        <StateIcon
          aria-hidden
          className={`mrpr-icon ${state?.toneClassName ?? 'mrpr-tone-draft'}`}
        />
        {/* As on a chip, the repository without its owner. */}
        <PullRequestMetaLine>
          <span key="number" className="mrpr-truncate">
            {t('details.pullRequest', { repository: pullRequest.repo, number: pullRequest.number })}
          </span>
          {state ? (
            // The tone colors the words through `mrpr-details-word`, in a shade text can have.
            <span key="state" className={state.toneClassName}>
              <span className="mrpr-details-word mrpr-details-state">
                {t(`state.${state.key}`)}
              </span>
            </span>
          ) : null}
          {mark ? (
            <span
              key="checks"
              className={`mrpr-state ${mark.toneClassName}`}
              title={t(`checksState.${checks}`)}
            >
              <mark.Icon aria-hidden className="mrpr-icon" />
              <span className="mrpr-details-word">{t(`details.checks.${checks}`)}</span>
            </span>
          ) : null}
        </PullRequestMetaLine>
      </div>
      {pr ? <LoadedPullRequestDetails pr={pr} here={pr.headRef === worktreeBranch} /> : null}
    </div>
  );
}

function LoadedPullRequestDetails({ pr, here }: { pr: PullRequest; here: boolean }) {
  const t = usePluginTranslation('pull-requests');
  return (
    <>
      <p className="mrpr-details-title">{pr.title}</p>
      <PullRequestMetaLine>
        {/* Without a changed line the stat draws nothing, so it is left out with its separator. */}
        {pr.additions > 0 || pr.deletions > 0 ? (
          <PullRequestDiffStat key="size" additions={pr.additions} deletions={pr.deletions} />
        ) : null}
        <span key="files">{t('code.fileCount', { count: pr.changedFiles })}</span>
        <span key="updated">
          <RelativeTime timestamp={pr.updatedAt} />
        </span>
        {here ? (
          <span key="here" className="mrpr-state mrpr-details-here">
            <Folder aria-hidden className="mrpr-icon" />
            {t('details.thisWorktree')}
          </span>
        ) : null}
      </PullRequestMetaLine>
    </>
  );
}

function WorktreeDetails({
  worktree,
  showBranch,
}: {
  worktree: ThreadWorktree;
  showBranch: boolean;
}) {
  const t = usePluginTranslation('pull-requests');
  const { path, branch } = worktree;
  return (
    <div className="mrpr-details-worktree">
      <p className="mrpr-details-label">{t('details.worktree')}</p>
      {branch && showBranch ? (
        <div className="mrpr-details-row">
          <GitBranch aria-hidden className="mrpr-icon" />
          <span className="mrpr-details-wrap">{branch}</span>
        </div>
      ) : null}
      <div className="mrpr-details-row">
        <Folder aria-hidden className="mrpr-icon" />
        <span className="mrpr-details-wrap mrpr-details-path" title={path}>
          {middleTruncate(path, PATH_MAX)}
        </span>
      </div>
    </div>
  );
}
