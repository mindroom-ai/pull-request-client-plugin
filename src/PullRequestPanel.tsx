// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestDetailLayout.tsx and PullRequestDetailCrumbs.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The side panel: the header of the pull request a link opened, then its Summary and its Code.
import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import {
  ArrowLeft,
  Check,
  CircleCheck,
  Copy,
  FileDiff,
  GitCommitHorizontal,
  MessageSquare,
} from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { IconButton, IconTooltip } from '@mindroom/client-sdk/ui';
import { CodeTab, type ListState } from './CodeTab';
import { BaseBranch } from './detail/BaseBranch';
import { ChangeBreakdownStat } from './detail/ChangeBreakdownStat';
import { ChecksStatusLine } from './detail/ChecksStatusLine';
import { baseFreshness, latestReviewOutcomes } from './detail/detail.logic';
import { SummaryTab } from './detail/SummaryTab';
import { TimelineTab } from './detail/TimelineTab';
import {
  parsePullRequestUrl,
  pullRequestUrl,
  type PullRequest,
  type PullRequestRef,
} from './github';
import { GitHubErrorState } from './GitHubErrorState';
import {
  PullRequestActorLabel,
  PullRequestMetaLine,
  RelativeTime,
  resolvePullRequestState,
} from './presentation';
import {
  useBehindBy,
  useCommits,
  usePullRequest,
  usePullRequestFiles,
  useReviewComments,
  useReviews,
} from './queries';
import { buildReviewThreads } from './reviewThreads';
import { pluginRootStyle } from './theme';
import { useGitHubToken } from './token';

const TABS = ['summary', 'timeline', 'code'] as const;
type Tab = (typeof TABS)[number];

/** The pull request a side panel request names, or undefined for anything that is not one. */
function readRequest(request: unknown): PullRequestRef | undefined {
  if (typeof request !== 'object' || request === null) return undefined;
  const { owner, repo, number } = request as Record<string, unknown>;
  if (typeof owner !== 'string' || typeof repo !== 'string' || typeof number !== 'number') {
    return undefined;
  }
  try {
    const parsed = parsePullRequestUrl(new URL(pullRequestUrl({ owner, repo, number })));
    // The URL parser resolves dot segments, so "../x" would name another repository; the request
    // counts only when it comes out as it went in.
    return parsed?.owner === owner && parsed.repo === repo && parsed.number === number
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

type Order = 'newest' | 'oldest';

function TabBar({
  value,
  onChange,
  end,
}: {
  value: Tab;
  onChange: (tab: Tab) => void;
  /** What the bar shows after the tabs, which depends on the tab. */
  end: ReactNode;
}) {
  const t = usePluginTranslation('pull-requests');
  const barRef = useRef<HTMLDivElement>(null);
  const onKeyDown = (event: KeyboardEvent) => {
    const rtl = barRef.current ? getComputedStyle(barRef.current).direction === 'rtl' : false;
    const forward = rtl ? 'ArrowLeft' : 'ArrowRight';
    const backward = rtl ? 'ArrowRight' : 'ArrowLeft';
    if (event.key !== forward && event.key !== backward) return;
    event.preventDefault();
    const step = event.key === forward ? 1 : -1;
    const next = TABS[(TABS.indexOf(value) + step + TABS.length) % TABS.length] ?? value;
    onChange(next);
    barRef.current?.querySelector<HTMLElement>(`#mrpr-tab-${next}`)?.focus();
  };
  return (
    <div className="mrpr-tabbar">
      <div ref={barRef} className="mrpr-tabs" role="tablist" onKeyDown={onKeyDown}>
        {TABS.map((tab) => (
          <button
            key={tab}
            id={`mrpr-tab-${tab}`}
            className="mrpr-tab"
            type="button"
            role="tab"
            aria-selected={tab === value}
            aria-controls={`mrpr-tabpanel-${tab}`}
            tabIndex={tab === value ? 0 : -1}
            onClick={() => onChange(tab)}
          >
            {t(`tab.${tab}`)}
          </button>
        ))}
      </div>
      <div className="mrpr-tabbar-end">{end}</div>
    </div>
  );
}

function Count({ icon, count, label }: { icon: ReactNode; count: number; label: string }) {
  return (
    <span className="mrpr-count" title={label}>
      {icon}
      <span aria-hidden>{count}</span>
      <span className="mrpr-sr-only">{label}</span>
    </span>
  );
}

/** What the Timeline tab's bar shows: the counts of the pull request and the order of the events. */
function TimelineBarEnd({
  pullRequest,
  pullRequestRef,
  order,
  onOrder,
}: {
  pullRequest: PullRequest;
  pullRequestRef: PullRequestRef;
  order: Order;
  onOrder: (order: Order) => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const reviews = useReviews(pullRequestRef, true);
  const approvals = reviews.data
    ? latestReviewOutcomes(reviews.data.items, pullRequest.headSha).filter(
        (outcome) => outcome.verdict === 'approved' && !outcome.stale
      ).length
    : undefined;
  return (
    <>
      <Count
        icon={<MessageSquare aria-hidden className="mrpr-icon" />}
        count={pullRequest.commentCount + pullRequest.reviewCommentCount}
        label={t('timeline.comments', {
          count: pullRequest.commentCount + pullRequest.reviewCommentCount,
        })}
      />
      <Count
        icon={<GitCommitHorizontal aria-hidden className="mrpr-icon" />}
        count={pullRequest.commitCount}
        label={t('timeline.commits', { count: pullRequest.commitCount })}
      />
      {approvals === undefined ? null : (
        <Count
          icon={<CircleCheck aria-hidden className="mrpr-icon mrpr-tone-success" />}
          count={approvals}
          label={t('timeline.approvals', { count: approvals })}
        />
      )}
      <button
        type="button"
        className="mrpr-button"
        onClick={() => onOrder(order === 'newest' ? 'oldest' : 'newest')}
      >
        {t(order === 'newest' ? 'timeline.newestFirst' : 'timeline.oldestFirst')}
      </button>
    </>
  );
}

/** The button that copies the command to check the pull request out; it says so for a moment. */
function CopyCheckoutButton({ command }: { command: string }) {
  const t = usePluginTranslation('pull-requests');
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 1500);
    return () => clearTimeout(timer);
  }, [copied]);
  const label = copied ? t('copied') : t('copyCheckout');
  const Icon = copied ? Check : Copy;
  return (
    <IconTooltip label={label}>
      {(triggerRef) => (
        <IconButton
          ref={triggerRef}
          size="300"
          radii="300"
          aria-label={label}
          onClick={() => {
            // A browser that refuses the clipboard leaves the button as it was.
            // A page without a clipboard (an insecure context) has nothing to copy with.
            try {
              void navigator.clipboard?.writeText(command).then(
                () => setCopied(true),
                () => undefined
              );
            } catch {
              // The clipboard refused at once; the button stays as it was.
            }
          }}
        >
          <Icon aria-hidden className="mrpr-button-icon" />
        </IconButton>
      )}
    </IconTooltip>
  );
}

/** What the Code tab is told of a list a query loads: its items, else its error and a retry. */
function listState<T>(
  items: T[] | undefined,
  query: { isError: boolean; error: unknown; refetch: () => Promise<unknown> }
): ListState<T> {
  if (items) return { status: 'success', items };
  if (query.isError) {
    return { status: 'error', error: query.error, retry: () => void query.refetch() };
  }
  return { status: 'pending' };
}

/** The Code tab with what it shows: the files, the review threads and the commits. */
function Files({
  pullRequest,
  commit,
  onCommitChange,
}: {
  pullRequest: PullRequestRef;
  commit: string | undefined;
  onCommitChange: (sha: string | undefined) => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const query = usePullRequestFiles(pullRequest, true);
  const reviewComments = useReviewComments(pullRequest, true);
  const commits = useCommits(pullRequest, true);
  const threads = useMemo(
    () => reviewComments.data && buildReviewThreads(reviewComments.data.items),
    [reviewComments.data]
  );
  if (query.data) {
    return (
      <CodeTab
        // The tab's own state, such as its open bar, folds and selector, is one pull request's.
        key={pullRequestUrl(pullRequest)}
        pullRequest={pullRequest}
        files={query.data}
        threads={listState(threads, reviewComments)}
        commits={listState(commits.data?.items, commits)}
        commit={commit}
        onCommitChange={onCommitChange}
        truncatedReviewComments={
          reviewComments.data?.truncated ? reviewComments.data.items.length : undefined
        }
      />
    );
  }
  return (
    <div className="mrpr-panel-note">
      {query.isError ? (
        <GitHubErrorState error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <p className="mrpr-status">{t('loadingFiles')}</p>
      )}
    </div>
  );
}

export default function PullRequestPanel({ request }: { roomId: string; request?: unknown }) {
  const t = usePluginTranslation('pull-requests');
  const ref = useMemo(() => readRequest(request), [request]);
  const query = usePullRequest(ref);
  const { token, forget } = useGitHubToken();
  const [tab, setTab] = useState<Tab>('summary');
  // The Timeline tab's order, which the tab bar's toggle sets.
  const [order, setOrder] = useState<Order>('newest');
  // The commit the Code tab shows, chosen there or from the Timeline. It belongs to the pull
  // request it was chosen in: another one opens on All commits.
  const pullRequestKey = ref ? pullRequestUrl(ref) : '';
  const [commitScope, setCommitScope] = useState<{ pullRequestKey: string; sha?: string }>({
    pullRequestKey,
  });
  const selectedCommit =
    commitScope.pullRequestKey === pullRequestKey ? commitScope.sha : undefined;
  const selectCommit = (sha: string | undefined) => setCommitScope({ pullRequestKey, sha });
  const pr = query.data;
  const state = pr && resolvePullRequestState(pr);
  // A branch is out of date only while the pull request can still merge.
  const behind = useBehindBy(ref, pr?.baseRef ?? '', pr?.headSha ?? '', pr?.state === 'open');
  const freshness =
    pr?.state === 'open' ? baseFreshness(behind.data, pr.mergeableState) : undefined;
  const forkOwner =
    pr?.headRepo && pr.headRepo !== pr.baseRepo ? pr.headRepo.split('/')[0] : undefined;

  return (
    <div className="mrpr-root mrpr-panel" style={pluginRootStyle()}>
      {!ref ? (
        <p className="mrpr-status mrpr-panel-note">{t('emptyPanel')}</p>
      ) : !pr || !state ? (
        <div className="mrpr-panel-note">
          {query.isError ? (
            <GitHubErrorState error={query.error} onRetry={() => void query.refetch()} />
          ) : (
            <p className="mrpr-status">{t('loading')}</p>
          )}
        </div>
      ) : (
        <>
          <div className="mrpr-header">
            <div className="mrpr-crumbs">
              <state.Icon aria-hidden className={`mrpr-icon ${state.toneClassName}`} />
              <a
                className="mrpr-crumb-link mrpr-truncate"
                href={`https://github.com/${ref.owner}/${ref.repo}`}
                target="_blank"
                rel="noopener noreferrer"
              >
                {ref.owner}/{ref.repo}
              </a>
              <a
                className={`mrpr-crumb-link mrpr-shrink-0 ${state.toneClassName}`}
                href={pr.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                #{ref.number}
              </a>
              <span className="mrpr-badges">
                {state.key === 'open' ? null : (
                  <span className={`mrpr-badge mrpr-badge-state ${state.toneClassName}`}>
                    {t(`state.${state.key}`)}
                  </span>
                )}
                {pr.autoMerge ? (
                  <span className="mrpr-badge mrpr-badge-outline">
                    {t('badge.autoMerge', { method: pr.autoMerge.method })}
                  </span>
                ) : null}
              </span>
            </div>
            <p className="mrpr-panel-title">{pr.title}</p>
            <div className="mrpr-panel-meta">
              <PullRequestMetaLine>
                <PullRequestActorLabel key="author" actor={pr.author} profileUrl={pr.author?.url} />
                <span key="updated" className="mrpr-shrink-0">
                  <RelativeTime timestamp={pr.updatedAt} label={(time) => t('updated', { time })} />
                </span>
              </PullRequestMetaLine>
              <CopyCheckoutButton
                command={`gh pr checkout ${ref.number} -R ${ref.owner}/${ref.repo}`}
              />
            </div>
            <div className="mrpr-branches">
              <span className="mrpr-refs">
                <BaseBranch baseBranch={pr.baseRef} headBranch={pr.headRef} freshness={freshness} />
                <ArrowLeft
                  aria-label={t('receivesChanges')}
                  className="mrpr-arrow mrpr-arrow-back"
                />
                <span className="mrpr-truncate">
                  {forkOwner ? `${forkOwner}:${pr.headRef}` : pr.headRef}
                </span>
              </span>
              <span className="mrpr-counts">
                <span className="mrpr-file-count">
                  <FileDiff aria-hidden className="mrpr-arrow mrpr-file-icon" />
                  {t('code.fileCount', { count: pr.changedFiles })}
                </span>
                <ChangeBreakdownStat
                  pullRequestRef={ref}
                  additions={pr.additions}
                  deletions={pr.deletions}
                />
              </span>
            </div>
            <div className="mrpr-header-actions">
              <a className="mrpr-link" href={pr.url} target="_blank" rel="noopener noreferrer">
                {t('openOnGitHub')}
              </a>
              {token !== undefined ? (
                <button className="mrpr-button" type="button" onClick={forget}>
                  {t('token.forget')}
                </button>
              ) : null}
            </div>
          </div>
          <TabBar
            value={tab}
            onChange={setTab}
            end={
              tab === 'summary' ? (
                <ChecksStatusLine pullRequest={pr} pullRequestRef={ref} />
              ) : tab === 'timeline' ? (
                <TimelineBarEnd
                  pullRequest={pr}
                  pullRequestRef={ref}
                  order={order}
                  onOrder={setOrder}
                />
              ) : null
            }
          />
          <div
            className={tab === 'code' ? 'mrpr-tabpanel mrpr-tabpanel-code' : 'mrpr-tabpanel'}
            role="tabpanel"
            id={`mrpr-tabpanel-${tab}`}
            aria-labelledby={`mrpr-tab-${tab}`}
          >
            {tab === 'summary' ? (
              <SummaryTab pullRequest={pr} pullRequestRef={ref} />
            ) : tab === 'timeline' ? (
              <TimelineTab
                pullRequestRef={ref}
                pullRequest={pr}
                order={order}
                onOpenCommit={(sha) => {
                  selectCommit(sha);
                  setTab('code');
                }}
              />
            ) : (
              <Files pullRequest={ref} commit={selectedCommit} onCommitChange={selectCommit} />
            )}
          </div>
        </>
      )}
    </div>
  );
}
