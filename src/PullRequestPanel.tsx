// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestDetailLayout.tsx and PullRequestDetailCrumbs.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The side panel: the header of the pull request a link opened, then its Summary and its Code.
// It shows its own name and Close (`title: 'own'`), so the room draws no title row above it.
import {
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from 'react';
import { IconButton as PlainIconButton } from 'folds';
import {
  ArrowLeft,
  CircleCheck,
  FileDiff,
  GitCommitHorizontal,
  MessageSquare,
  X,
} from 'lucide-react';
import { usePluginTranslation, useRoomSidePanel } from '@mindroom/client-sdk/core';
import { IconTooltip } from '@mindroom/client-sdk/ui';
import { useHeaderActions } from './actions/HeaderActions';
import { usePullRequestActions } from './actions/usePullRequestActions';
import { CodeTab, type ListState } from './CodeTab';
import { BaseBranch } from './detail/BaseBranch';
import { ChangeBreakdownStat } from './detail/ChangeBreakdownStat';
import { ChecksStatusLine } from './detail/ChecksStatusLine';
import { baseFreshness, commitsCut, latestReviewOutcomes } from './detail/detail.logic';
import { SummaryTab } from './detail/SummaryTab';
import { TimelineTab } from './detail/TimelineTab';
import {
  parsePullRequestUrl,
  pullRequestUrl,
  type PullRequest,
  type PullRequestRef,
} from './github';
import { GitHubErrorState, useErrorTokenReason } from './GitHubErrorState';
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
import { clearShownPullRequest, setShownPullRequest } from './shownPullRequest';
import { pluginRootStyle } from './theme';
import {
  PanelTokenFormContext,
  GitHubServerContext,
  RemovedTokenNote,
  usePlaceFocus,
  RemovedTokenProvider,
  RoomGitHub,
  TokenForm,
  type TokenFormReason,
  useGitHubAccess,
  useGitHubToken,
  usePanelTokenForm,
} from './token';

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

/** The panel's own Close (`title: 'own'`): the room draws no title row above the panel. */
function CloseButton() {
  const t = usePluginTranslation('pull-requests');
  const panel = useRoomSidePanel('pull-requests', 'pull-request');
  if (!panel) return null;
  const label = t('closePanel');
  return (
    <IconTooltip label={label} align="End">
      {(triggerRef) => (
        // As the menu's button beside it, without a fill.
        <PlainIconButton
          ref={triggerRef}
          size="300"
          radii="300"
          variant="SurfaceVariant"
          fill="None"
          className="mrpr-header-more"
          aria-label={label}
          onClick={panel.close}
        >
          <X aria-hidden className="mrpr-button-icon" />
        </PlainIconButton>
      )}
    </IconTooltip>
  );
}

/** The box that scrolls the panel: the nearest ancestor whose content scrolls, the room's. */
function scrollerOf(element: HTMLElement): HTMLElement | null {
  for (let node = element.parentElement; node; node = node.parentElement) {
    if (/auto|scroll/.test(getComputedStyle(node).overflowY)) return node;
  }
  return null;
}

/**
 * Whether the header has scrolled out of view under the panel's top row, while `watches`: one
 * observer of the header against the box that scrolls, no listener of every scroll, made again
 * when the top row's height changes (Page Zoom). The part of the top row that changes with it,
 * `swap`, gives the focus it had to its counterpart there, marked `data-mrpr-swap-focus`.
 */
function useScrolledAway(
  header: RefObject<HTMLElement>,
  bar: RefObject<HTMLElement>,
  swap: RefObject<HTMLElement>,
  watches: boolean
): boolean {
  const [away, setAway] = useState(false);
  const [barSize, setBarSize] = useState(0);
  // Whether the part that changes had the focus as it changed.
  const refocus = useRef(false);
  useEffect(() => {
    const element = bar.current;
    if (!element || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries[entries.length - 1];
      if (entry) setBarSize(Math.round(entry.contentRect.height));
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [bar]);
  useEffect(() => {
    const element = header.current;
    if (!watches || !element || typeof IntersectionObserver === 'undefined') return undefined;
    const observer = new IntersectionObserver(
      (entries) => {
        const entry = entries[entries.length - 1];
        if (entry) setAway(!entry.isIntersecting);
      },
      // The top row stays over the box's top, so what is under it is out of view.
      { root: scrollerOf(element), rootMargin: `-${barSize}px 0px 0px 0px` }
    );
    observer.observe(element);
    // The observer made again for a new height keeps what the last one saw until it reports.
    return () => observer.disconnect();
  }, [barSize, header, watches]);
  // Unwatched, it starts again from the header in view.
  useEffect(() => {
    if (!watches) setAway(false);
  }, [watches]);
  const collapsed = watches && away;
  // Whether the part that changes has the focus, read as it is about to change, while the element
  // that has it is still on the page: by scrolling, or as the header stays in place (`watches`).
  const shown = useRef(collapsed);
  if (shown.current !== collapsed) {
    shown.current = collapsed;
    refocus.current = swap.current?.contains(document.activeElement) ?? false;
  }
  useLayoutEffect(() => {
    if (!refocus.current) return;
    refocus.current = false;
    swap.current
      ?.querySelector<HTMLElement>('[data-mrpr-swap-focus]')
      ?.focus({ preventScroll: true });
  }, [collapsed, swap]);
  return collapsed;
}

/**
 * The pull request's header, top to bottom: the top row (state, repository, number, badges, More
 * actions and Close), the title, the author and changes, the branches with the primary control,
 * and the lines of what runs. In the tabs that scroll with it (`collapses`), once it is out of
 * view the top row stays as a bar with the number and title, which scrolls back up to it.
 */
function Header({
  pr,
  pullRequestRef: ref,
  state,
  actions,
  freshness,
  collapses,
  onHold,
  onUseToken,
  onForgetToken,
}: {
  pr: PullRequest;
  pullRequestRef: PullRequestRef;
  state: NonNullable<ReturnType<typeof resolvePullRequestState>>;
  actions: ReturnType<typeof usePullRequestActions>;
  freshness: ReturnType<typeof baseFreshness>;
  collapses: boolean;
  /** Told whether the header stays in place: an action runs, or a line says what came of one. */
  onHold: (holds: boolean) => void;
  onUseToken?: () => void;
  onForgetToken?: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const headerRef = useRef<HTMLDivElement>(null);
  const barRef = useRef<HTMLDivElement>(null);
  const swapRef = useRef<HTMLSpanElement>(null);
  const collapsed = useScrolledAway(headerRef, barRef, swapRef, collapses);
  const { control, menu, lines, holds } = useHeaderActions({
    pullRequestRef: ref,
    pullRequest: pr,
    actions,
    checkout: `gh pr checkout ${ref.number} -R ${ref.owner}/${ref.repo}`,
    onUseToken,
    onForgetToken,
  });
  useLayoutEffect(() => {
    onHold(holds);
    return () => onHold(false);
  }, [holds, onHold]);
  // A hold that starts while the header is out of view, as from the bar's More actions, and a
  // line that comes under it while it holds (what a merge started at the top came to, after a
  // scroll), bring the header and its line back into view.
  const wasCollapsed = useRef(collapsed);
  wasCollapsed.current = collapsed;
  useLayoutEffect(() => {
    const header = headerRef.current;
    const scroller = header && scrollerOf(header);
    if (!holds || !header || !scroller) return;
    const under = scroller.getBoundingClientRect().top + (barRef.current?.offsetHeight ?? 0);
    if (wasCollapsed.current || header.getBoundingClientRect().bottom <= under) {
      scroller.scrollTo({ top: 0 });
    }
  }, [holds, actions.result]);
  const forkOwner =
    pr.headRepo && pr.headRepo !== pr.baseRepo ? pr.headRepo.split('/')[0] : undefined;
  const showDetails = () => {
    const header = headerRef.current;
    const scroller = header && scrollerOf(header);
    const still = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    scroller?.scrollTo({ top: 0, behavior: still ? 'auto' : 'smooth' });
    header?.querySelector<HTMLElement>('.mrpr-panel-title')?.focus({ preventScroll: true });
  };
  const stateIcon = <state.Icon aria-hidden className={`mrpr-icon ${state.toneClassName}`} />;
  return (
    <>
      <div ref={barRef} className="mrpr-crumbs mrpr-bar">
        <span ref={swapRef} className="mrpr-bar-swap">
          {collapsed ? (
            <button
              type="button"
              className="mrpr-bar-details"
              aria-label={t('showDetails', { number: ref.number, title: pr.title })}
              data-mrpr-swap-focus
              onClick={showDetails}
            >
              {stateIcon}
              <span className={`mrpr-shrink-0 ${state.toneClassName}`}>#{ref.number}</span>
              <span className="mrpr-truncate mrpr-bar-title">{pr.title}</span>
            </button>
          ) : (
            <>
              {stateIcon}
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
                data-mrpr-swap-focus
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
            </>
          )}
        </span>
        <span className="mrpr-bar-end">
          {menu}
          <CloseButton />
        </span>
      </div>
      <div ref={headerRef} className="mrpr-header">
        <h2 className="mrpr-panel-title" tabIndex={-1}>
          {pr.title}
        </h2>
        <div className="mrpr-panel-meta">
          <PullRequestMetaLine>
            <PullRequestActorLabel key="author" actor={pr.author} profileUrl={pr.author?.url} />
            <span key="updated" className="mrpr-truncate">
              <RelativeTime timestamp={pr.updatedAt} label={(time) => t('updated', { time })} />
            </span>
          </PullRequestMetaLine>
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
        <div className="mrpr-branches">
          <span className="mrpr-refs">
            <BaseBranch
              baseBranch={pr.baseRef}
              headBranch={pr.headRef}
              freshness={freshness}
              // As T3 Code: an update only for a branch GitHub found mergeable, not while it
              // still computes that (null) nor for one that conflicts.
              onUpdate={
                actions.repo?.canWrite && pr.mergeable === true
                  ? (action) => actions.perform(action)
                  : undefined
              }
              updating={actions.pending !== null}
            />
            <ArrowLeft aria-label={t('receivesChanges')} className="mrpr-arrow mrpr-arrow-back" />
            <span className="mrpr-truncate">
              {forkOwner ? `${forkOwner}:${pr.headRef}` : pr.headRef}
            </span>
          </span>
          {control}
        </div>
        <div className="mrpr-header-lines">{lines}</div>
      </div>
    </>
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
  commitCount,
  commit,
  onCommitChange,
}: {
  pullRequest: PullRequestRef;
  /** How many commits the pull request has, which the list of them may fall short of. */
  commitCount: number;
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
        truncatedCommits={
          commits.data && commitsCut(commits.data, commitCount)
            ? commits.data.items.length
            : undefined
        }
      />
    );
  }
  return (
    <div className="mrpr-panel-note">
      {query.isError ? (
        <GitHubErrorState compact error={query.error} onRetry={() => void query.refetch()} />
      ) : (
        <p className="mrpr-status">{t('loadingFiles')}</p>
      )}
    </div>
  );
}

type PanelProps = { roomId: string; request?: unknown };

export default function PullRequestPanel(props: PanelProps) {
  return (
    <RoomGitHub roomId={props.roomId}>
      {/* A token removed from MindRoom may take the pull request with it (it reads anonymously
          then, or not at all), so the panel says it was removed, where neither view replaces it. */}
      <RemovedTokenProvider>
        <Panel {...props} />
      </RemovedTokenProvider>
    </RoomGitHub>
  );
}

function Panel({ roomId, request }: PanelProps) {
  const t = usePluginTranslation('pull-requests');
  const ref = useMemo(() => readRequest(request), [request]);
  // The open thread's pull requests menu marks the item of the pull request the panel shows.
  useEffect(() => {
    setShownPullRequest(roomId, ref);
    return () => clearShownPullRequest(roomId, ref);
  }, [roomId, ref]);
  const query = usePullRequest(ref);
  const { token, forget } = useGitHubToken();
  const { via, unreadable, key: accessKey } = useGitHubAccess();
  const { server } = useContext(GitHubServerContext);
  const serverOrigin = server?.origin ?? '';
  const pullRequestKey = ref ? pullRequestUrl(ref) : '';
  const formScope = `${serverOrigin} ${pullRequestKey}`;
  const tokenForm = usePanelTokenForm(formScope);
  // The token form a person opened to use a token instead of MindRoom's connection, which goes
  // once a token is saved.
  const [overriding, setOverriding] = useState(false);
  const focusTokenForm = tokenForm.context.focus;
  useEffect(() => {
    if (via !== 'server') setOverriding(false);
    else if (overriding) focusTokenForm();
  }, [focusTokenForm, overriding, via]);
  // A control that goes while it has the focus (Remove token from MindRoom once removed, the
  // form once it saved) would leave the focus on the page: it goes to the panel's title, or to
  // the token field while no pull request shows. Nothing blurs when its element goes.
  const root = useRef<HTMLDivElement>(null);
  const focused = useRef(false);
  const placeFocus = usePlaceFocus();
  useEffect(() => {
    if (!focused.current || document.activeElement !== document.body) return;
    placeFocus(root.current?.querySelector<HTMLElement>('.mrpr-panel-title, .mrpr-token input'));
  });
  const [tab, setTab] = useState<Tab>('summary');
  // The Timeline tab's order, which the tab bar's toggle sets.
  const [order, setOrder] = useState<Order>('newest');
  // The commit the Code tab shows, chosen there or from the Timeline. It belongs to the pull
  // request it was chosen in: another one opens on All commits.
  // What GitHub answered last, shown while the pull request is read again with the same access:
  // a read again from an error forgets it. Read with another, it says nothing of now.
  const readAs = `${accessKey} ${formScope}`;
  const lastError = useRef<{ key: string; error: unknown }>();
  if (query.isError) lastError.current = { key: readAs, error: query.error };
  const error = query.isError
    ? query.error
    : query.isFetching && lastError.current?.key === readAs
    ? lastError.current.error
    : undefined;
  const [commitScope, setCommitScope] = useState<{ pullRequestKey: string; sha?: string }>({
    pullRequestKey,
  });
  const selectedCommit =
    commitScope.pullRequestKey === pullRequestKey ? commitScope.sha : undefined;
  const selectCommit = (sha: string | undefined) => setCommitScope({ pullRequestKey, sha });
  const pr = query.data;
  const state = pr && resolvePullRequestState(pr);
  // One runner for every control that changes the pull request, so one action runs at a time.
  const actions = usePullRequestActions(ref, pr);
  // A branch is out of date only while the pull request can still merge.
  const behind = useBehindBy(ref, pr?.baseRef ?? '', pr?.headSha ?? '', pr?.state === 'open');
  const freshness =
    pr?.state === 'open' ? baseFreshness(behind.data, pr.mergeableState) : undefined;
  // Why the panel's token form shows: in the loaded view, for the token MindRoom cannot read, a
  // part below that a token would let load, or Use a token in this browser; else as the error
  // view says.
  const errorReason = useErrorTokenReason(error);
  const formReason: TokenFormReason | undefined = !ref
    ? undefined
    : !pr || !state
    ? errorReason
    : unreadable
    ? 'unreadable'
    : tokenForm.reason ?? (overriding && via === 'server' ? 'override' : undefined);
  // Latched for the scope from the render it first shows in; a reason gone since leaves it
  // without a hint (`override`). Each latch is its own value: one of another scope is released,
  // and only the form shown for this latch may close it.
  const [latch, setLatch] = useState<{ scope: string }>();
  // Forgetting the browser's token is the person's act too, from whichever view it is.
  const [knownToken, setKnownToken] = useState(token);
  if (knownToken !== token) {
    setKnownToken(token);
    if (token === undefined) setLatch(undefined);
  }
  const held = latch?.scope === formScope ? latch : undefined;
  if (!held && (latch || formReason)) setLatch(formReason ? { scope: formScope } : undefined);
  const shownReason = formReason ?? (held ? 'override' : undefined);
  const currentLatch = useRef(held);
  currentLatch.current = held;
  const closeForm = (mine: typeof held) => () => {
    if (currentLatch.current !== mine) return;
    // The kept error is of the token replaced, so it says nothing of the new one.
    lastError.current = undefined;
    setOverriding(false);
    setLatch(undefined);
  };
  // Summary and Timeline scroll with the header, in the room's box, the Code tab in itself. While
  // an action runs or a line under the header says what came of one, the header does not collapse
  // (`Header`'s `onHold`), so the line stays with it.
  const [headerHeld, setHeaderHeld] = useState(false);
  const scrolls = tab !== 'code';

  return (
    <div
      ref={root}
      className={scrolls ? 'mrpr-root mrpr-panel mrpr-panel-scrolls' : 'mrpr-root mrpr-panel'}
      style={pluginRootStyle()}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
    >
      <PanelTokenFormContext.Provider value={tokenForm.context}>
        <RemovedTokenNote className="mrpr-status mrpr-panel-removed" />
        {!ref || !pr || !state ? (
          <>
            {/* The panel's name and Close until a pull request shows. */}
            <div className="mrpr-crumbs mrpr-bar">
              <h2 className="mrpr-bar-label mrpr-truncate">{t('panelLabel')}</h2>
              <span className="mrpr-bar-end">
                <CloseButton />
              </span>
            </div>
            {!ref ? (
              <p className="mrpr-status mrpr-panel-note">{t('emptyPanel')}</p>
            ) : (
              <div className="mrpr-panel-note">
                {error === undefined ? (
                  <p className="mrpr-status">{t('loading')}</p>
                ) : (
                  <GitHubErrorState
                    error={error}
                    onRetry={() => void query.refetch()}
                    withTokenForm={false}
                  />
                )}
              </div>
            )}
          </>
        ) : (
          <Header
            pr={pr}
            pullRequestRef={ref}
            state={state}
            actions={actions}
            freshness={freshness}
            collapses={scrolls && !headerHeld}
            onHold={setHeaderHeld}
            // Who the requests go as and what changes that sit in its menu, out of the way.
            onUseToken={
              via === 'server' && !tokenForm.reason && !overriding
                ? () => setOverriding(true)
                : undefined
            }
            onForgetToken={token !== undefined ? forget : undefined}
          />
        )}
        {/* Invariant: the panel's token form has exactly one owner, here, and one tree position,
          keyed only by the server's origin and the pull request; the loading, error and loaded
          views never mount their own copy. Once it has shown for (origin, pull request), it stays
          mounted until the person cancels it, a save or removal it started succeeds, or the origin
          or pull request changes. Reads and status changes never unmount it. */}
        {shownReason ? (
          <div className="mrpr-panel-token" key={formScope}>
            <TokenForm
              reason={shownReason}
              inputRef={tokenForm.inputRef}
              // Only one opened to use a token instead, or latched with nothing to show it for,
              // closes: a failure keeps the other.
              onCancel={
                (shownReason === 'override' && overriding) || !formReason
                  ? closeForm(held)
                  : undefined
              }
              onDone={closeForm(held)}
            />
          </div>
        ) : null}
        {pr && state && ref ? (
          <>
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
                <Files
                  pullRequest={ref}
                  commitCount={pr.commitCount}
                  commit={selectedCommit}
                  onCommitChange={selectCommit}
                />
              )}
            </div>
          </>
        ) : null}
      </PanelTokenFormContext.Provider>
    </div>
  );
}
