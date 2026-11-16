// A thread's details, in the hover card of its card in the Compact view and as the first group of
// its menu: each of its pull requests, also those past the two its card shows, then its worktree.
// The app draws them as read-only rows, so nothing here is a control or takes the focus. A pull
// request asks GitHub through the chips' own queries, so its chip's answer is already there.
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
import { NO_FOCUS_REFETCH } from './queries';
import { pluginRootStyle } from './theme';
import { useThreadPullRequests, type ThreadWorktree } from './threadPullRequests';

/** The most code points each side of a pull request's branches shows. */
const BRANCH_MAX = 24;

// A hover shows what GitHub answered a chip, however old: only a pull request it has no answer for
// yet is asked for, so moving the pointer over cards spends none of the hourly limit.
const ANSWERED_ONLY = { ...NO_FOCUS_REFETCH, refetchOnMount: false };

export function ThreadDetails({ room, threadId }: ThreadDetailProps) {
  const { pullRequests, worktree } = useThreadPullRequests(room, threadId);
  // A thread can lose its last link or its worktree while a surface shows it: it then draws none.
  if (pullRequests.length === 0 && !worktree) return null;
  return (
    <div className="mrpr-root mrpr-details" style={pluginRootStyle()}>
      {pullRequests.map((pullRequest) => (
        <PullRequestDetails key={pullRequestUrl(pullRequest)} pullRequest={pullRequest} />
      ))}
      {worktree ? <WorktreeDetails worktree={worktree} /> : null}
    </div>
  );
}

function PullRequestDetails({ pullRequest }: { pullRequest: PullRequestRef }) {
  const t = usePluginTranslation('pull-requests');
  // The very ref the chip asks with: the same queries, so a chip that loaded leaves nothing to ask.
  const { pr, state, checks } = usePullRequestStatus(pullRequest, ANSWERED_ONLY);
  const mark = checks && {
    ...pullRequestChecksStatePresentation(checks),
    label: t(`checksState.${checks}`),
  };
  return (
    <div className="mrpr-details-pull-request">
      <div className="mrpr-details-row">
        {state ? (
          <state.Icon
            role="img"
            aria-label={t(`state.${state.key}`)}
            className={`mrpr-icon ${state.toneClassName}`}
          />
        ) : (
          // Until GitHub answers, or when it refuses, the plain icon in the draft's tone.
          <GitPullRequestArrow aria-hidden className="mrpr-icon mrpr-tone-draft" />
        )}
        <span className="mrpr-truncate">
          {t('details.pullRequest', {
            repository: `${pullRequest.owner}/${pullRequest.repo}`,
            number: pullRequest.number,
          })}
        </span>
        {mark ? (
          <mark.Icon
            role="img"
            aria-label={mark.label}
            className={`mrpr-icon ${mark.toneClassName}`}
          />
        ) : null}
      </div>
      {pr ? <LoadedPullRequestDetails pr={pr} /> : null}
    </div>
  );
}

function LoadedPullRequestDetails({ pr }: { pr: PullRequest }) {
  const t = usePluginTranslation('pull-requests');
  // A fork that was deleted has no repository: its head shows without an owner.
  const forkOwner =
    pr.headRepo !== null && pr.headRepo !== pr.baseRepo ? pr.headRepo.split('/')[0] : undefined;
  const head =
    forkOwner === undefined
      ? pr.headRef
      : t('details.forkHead', { owner: forkOwner, branch: pr.headRef });
  const branches = t('details.branches', {
    head: middleTruncate(head, BRANCH_MAX),
    base: middleTruncate(pr.baseRef, BRANCH_MAX),
  });
  return (
    <>
      <p className="mrpr-details-title">{pr.title}</p>
      <div className="mrpr-details-row">
        <GitBranch aria-hidden className="mrpr-icon mrpr-details-icon" />
        <span className="mrpr-truncate">{branches}</span>
      </div>
      <PullRequestMetaLine>
        {/* Without a changed line the stat draws nothing, so it is left out with its separator. */}
        {pr.additions > 0 || pr.deletions > 0 ? (
          <PullRequestDiffStat key="size" additions={pr.additions} deletions={pr.deletions} />
        ) : null}
        <span key="files" className="mrpr-shrink-0">
          {t('code.fileCount', { count: pr.changedFiles })}
        </span>
        <span key="author" className="mrpr-truncate">
          {t('details.author', { login: pr.author?.login ?? t('ghost') })}
        </span>
        <span key="updated" className="mrpr-shrink-0">
          <RelativeTime timestamp={pr.updatedAt} label={(time) => t('updated', { time })} />
        </span>
      </PullRequestMetaLine>
    </>
  );
}

function WorktreeDetails({ worktree }: { worktree: ThreadWorktree }) {
  const { path, branch } = worktree;
  return (
    <div className="mrpr-details-worktree">
      {branch ? (
        <div className="mrpr-details-row">
          <GitBranch aria-hidden className="mrpr-icon mrpr-details-icon" />
          <span className="mrpr-details-wrap">{branch}</span>
        </div>
      ) : null}
      <div className="mrpr-details-row">
        <Folder aria-hidden className="mrpr-icon mrpr-details-icon" />
        <span className="mrpr-details-wrap">{path}</span>
      </div>
    </div>
  );
}
