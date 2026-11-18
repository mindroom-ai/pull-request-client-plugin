// A thread's details, in the hover card of its card in the Compact view and as the first group of
// its menu: each of its pull requests, also those past the two its card shows, then its worktree.
// The app draws them as read-only rows, so nothing here is a control or takes the focus. A pull
// request asks GitHub through the chips' own queries, so its chip's answer is already there. A pull
// request on the worktree's branch says so, and the worktree then leaves its branch out. The open
// thread's pull requests menu draws the same rows, each pull request as one of its items.
import { Fragment, type ReactNode } from 'react';
import { usePluginTranslation, type ThreadDetailProps } from '@mindroom/client-sdk/core';
import { Folder, GitBranch, GitPullRequestArrow } from 'lucide-react';
import { pullRequestUrl, type PullRequest, type PullRequestRef } from './github';
import { middleTruncate } from './middleTruncate';
import {
  PullRequestDiffStat,
  PullRequestMetaLine,
  pullRequestChecksStatePresentation,
  RelativeTime,
} from './presentation';
import { usePullRequestStatus } from './pullRequestStatus';
import { NO_FOCUS_REFETCH, usePullRequests } from './queries';
import { pluginRootStyle } from './theme';
import { useThreadPullRequests, type ThreadWorktree } from './threadPullRequests';
import { RoomGitHub } from './token';

/** The most code points a worktree's path shows, shortened in its middle so its leaf stays. */
const PATH_MAX = 40;

// A hover shows what GitHub answered a chip, however old: only a pull request it has no answer for
// yet is asked for, so moving the pointer over cards spends none of the hourly limit. A refusal is an
// answer too: without `retryOnMount` every hover would ask again for a pull request GitHub refused.
export const ANSWERED_ONLY = { ...NO_FOCUS_REFETCH, refetchOnMount: false, retryOnMount: false };

export function ThreadDetails({ room, threadId }: ThreadDetailProps) {
  const { pullRequests, worktree } = useThreadPullRequests(room, threadId);
  // A thread can lose its last link or its worktree while a surface shows it: it then draws none.
  if (pullRequests.length === 0 && !worktree) return null;
  return (
    <RoomGitHub roomId={room.roomId}>
      <Details pullRequests={pullRequests} worktree={worktree} />
    </RoomGitHub>
  );
}

/**
 * The rows, inside `RoomGitHub`, so the heads are read with the room's access, as each chip reads
 * them. `item` wraps each pull request's and the worktree's rows (`pullRequest` undefined), as the
 * menu's items; `className` joins the root's.
 */
export function Details({
  pullRequests,
  worktree,
  item = (_pullRequest, rows) => rows,
  className,
}: {
  pullRequests: readonly PullRequestRef[];
  worktree: ThreadWorktree | undefined;
  item?: (pullRequest: PullRequestRef | undefined, rows: ReactNode) => ReactNode;
  className?: string;
}) {
  // The same queries as each pull request's below, so they ask GitHub nothing more.
  const heads = usePullRequests(pullRequests, ANSWERED_ONLY).map((query) => query.data?.headRef);
  return (
    <div
      className={className ? `mrpr-root mrpr-details ${className}` : 'mrpr-root mrpr-details'}
      style={pluginRootStyle()}
    >
      {pullRequests.map((pullRequest) => (
        <Fragment key={pullRequestUrl(pullRequest)}>
          {item(
            pullRequest,
            <PullRequestDetails pullRequest={pullRequest} worktreeBranch={worktree?.branch} />
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
}: {
  pullRequest: PullRequestRef;
  worktreeBranch: string | undefined;
}) {
  const t = usePluginTranslation('pull-requests');
  // The very ref the chip asks with: the same queries, so a chip that loaded leaves nothing to ask.
  const { pr, state, checks } = usePullRequestStatus(pullRequest, ANSWERED_ONLY);
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
