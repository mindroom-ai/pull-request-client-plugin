// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestTimelineTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Timeline tab: the opening, each commit, each verdict, each review thread, runs of plain
// comments in one row that opens, and the merge or close, along a vertical line. Events come from
// the queries that loaded; one that failed shows its own error with Retry above them.
import { useMemo, useState, type ReactNode } from 'react';
import {
  ChevronRight,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  MessageSquare,
} from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import type { Actor, Commit, PullRequest, PullRequestRef, Review } from '../github';
import { GitHubErrorState } from '../GitHubErrorState';
import {
  PullRequestActorAvatar,
  PullRequestActorLabel,
  PullRequestReviewOutcomeIcon,
  pullRequestReviewOutcomeToneClassName,
  RelativeTime,
  usePullRequestReviewOutcomeLabel,
} from '../presentation';
import { useCommits, useConversationComments, useReviewComments, useReviews } from '../queries';
import { buildReviewThreads } from '../reviewThreads';
import { CommentBody } from './CommentBody';
import { ConversationCard } from './ConversationCards';
import {
  buildTimeline,
  reviewOutcome,
  type ConversationItem,
  type TimelineEvent,
} from './detail.logic';

/** The round marker on the line: an actor's avatar, or an icon where there is none. */
function Marker({
  actor,
  icon,
  muted = false,
}: {
  actor?: Actor | null;
  icon: ReactNode;
  muted?: boolean;
}) {
  return (
    <span className={`mrpr-timeline-marker${muted ? ' mrpr-timeline-marker-muted' : ''}`}>
      {actor ? <PullRequestActorAvatar actor={actor} /> : icon}
    </span>
  );
}

const itemAuthor = (item: ConversationItem): Actor | null =>
  item.kind === 'comment'
    ? item.comment.author
    : item.kind === 'review'
    ? item.review.author
    : item.thread.comments[0]?.author ?? null;

const itemKey = (item: ConversationItem) =>
  item.kind === 'comment'
    ? `comment:${item.comment.id}`
    : item.kind === 'review'
    ? `review:${item.review.id}`
    : `thread:${item.thread.id}`;

function uniqueActors(items: ConversationItem[]): Actor[] {
  const actors = new Map<string, Actor>();
  for (const item of items) {
    const actor = itemAuthor(item);
    if (actor && !actors.has(actor.login)) actors.set(actor.login, actor);
  }
  return [...actors.values()];
}

/** A run of plain comments: "N comments · M authors", closed until chosen. */
function ConversationGroup({ items, at }: { items: ConversationItem[]; at: string }) {
  const t = usePluginTranslation('pull-requests');
  const [open, setOpen] = useState(false);
  const actors = uniqueActors(items);
  return (
    <li className="mrpr-timeline-event">
      <Marker
        actor={actors[0]}
        icon={<MessageSquare aria-hidden className="mrpr-icon" />}
        muted={!open}
      />
      <button
        type="button"
        className="mrpr-timeline-group-toggle"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
      >
        <span className="mrpr-timeline-title">
          {t('timeline.comments', { count: items.length })} ·{' '}
          {t('timeline.authors', { count: actors.length })}
        </span>
        <RelativeTime timestamp={at} />
        <ChevronRight
          aria-hidden
          className={`mrpr-icon mrpr-chevron${open ? ' mrpr-chevron-open' : ''}`}
        />
      </button>
      {open ? (
        <div className="mrpr-timeline-group-items">
          {items.map((item) => (
            <ConversationCard key={itemKey(item)} item={item} />
          ))}
        </div>
      ) : null}
    </li>
  );
}

function CommitEvent({ commit, onOpen }: { commit: Commit; onOpen: (sha: string) => void }) {
  const t = usePluginTranslation('pull-requests');
  return (
    <li className="mrpr-timeline-event">
      <Marker
        actor={commit.author}
        icon={<GitCommitHorizontal aria-hidden className="mrpr-icon" />}
      />
      <button
        type="button"
        className="mrpr-timeline-row"
        aria-label={t('timeline.viewCommit', { sha: commit.sha.slice(0, 7) })}
        onClick={() => onOpen(commit.sha)}
      >
        <span className="mrpr-timeline-title mrpr-truncate">
          {commit.headline || t('timeline.untitledCommit')}
        </span>
        <span className="mrpr-timeline-meta">
          <code className="mrpr-mono">{commit.sha.slice(0, 7)}</code>
          <RelativeTime timestamp={commit.committedAt} />
        </span>
      </button>
    </li>
  );
}

/** A verdict: who, what they decided (fainter when it was on earlier commits), when, and what they wrote. */
function VerdictEvent({ review, headSha }: { review: Review; headSha: string }) {
  const label = usePullRequestReviewOutcomeLabel();
  const outcome = reviewOutcome(review.state);
  if (!outcome) return null;
  const stale = review.commitId !== headSha;
  return (
    <li className="mrpr-timeline-event">
      <Marker actor={review.author} icon={<PullRequestReviewOutcomeIcon outcome={outcome} />} />
      <div className="mrpr-timeline-row">
        <span className="mrpr-timeline-meta">
          <PullRequestActorLabel actor={review.author} profileUrl={review.author?.url} />
          <span
            className={
              stale ? 'mrpr-timeline-stale' : pullRequestReviewOutcomeToneClassName(outcome)
            }
          >
            {label(outcome, stale)}
          </span>
          {review.url ? (
            <a
              className="mrpr-time-link"
              href={review.url}
              target="_blank"
              rel="noopener noreferrer"
            >
              <RelativeTime timestamp={review.submittedAt} />
            </a>
          ) : (
            <RelativeTime timestamp={review.submittedAt} />
          )}
        </span>
        {review.body.trim() ? <CommentBody body={review.body} /> : null}
      </div>
    </li>
  );
}

function LifecycleEvent({
  kind,
  at,
  actor,
}: {
  kind: 'opened' | 'merged' | 'closed';
  at: string;
  actor: Actor | null;
}) {
  const t = usePluginTranslation('pull-requests');
  const Icon =
    kind === 'opened' ? GitPullRequest : kind === 'merged' ? GitMerge : GitPullRequestClosed;
  return (
    <li className="mrpr-timeline-event">
      <Marker icon={<Icon aria-hidden className="mrpr-icon" />} />
      <div className="mrpr-timeline-row">
        <span className="mrpr-timeline-meta">
          {actor ? <PullRequestActorLabel actor={actor} profileUrl={actor.url} /> : null}
          <span className="mrpr-timeline-title">{t(`timeline.${kind}`)}</span>
        </span>
        <span className="mrpr-timeline-meta">
          <RelativeTime timestamp={at} />
        </span>
      </div>
    </li>
  );
}

function Event({
  event,
  pullRequest,
  onOpenCommit,
}: {
  event: TimelineEvent;
  pullRequest: PullRequest;
  onOpenCommit: (sha: string) => void;
}) {
  switch (event.kind) {
    case 'opened':
    case 'merged':
    case 'closed':
      return <LifecycleEvent kind={event.kind} at={event.at} actor={event.actor} />;
    case 'commit':
      return <CommitEvent commit={event.commit} onOpen={onOpenCommit} />;
    case 'verdict':
      return <VerdictEvent review={event.review} headSha={pullRequest.headSha} />;
    case 'thread':
      // GitHub's REST API has no resolved state, so a thread shows open, with its replies.
      return (
        <li className="mrpr-timeline-event">
          <Marker
            actor={event.thread.comments[0]?.author}
            icon={<MessageSquare aria-hidden className="mrpr-icon" />}
          />
          <div className="mrpr-timeline-group-items">
            <ConversationCard item={{ kind: 'thread', thread: event.thread }} />
          </div>
        </li>
      );
    case 'conversation':
      return <ConversationGroup items={event.items} at={event.at} />;
  }
}

const eventKey = (event: TimelineEvent, index: number) =>
  event.kind === 'commit'
    ? `commit:${event.commit.sha}`
    : event.kind === 'verdict'
    ? `verdict:${event.review.id}`
    : event.kind === 'thread'
    ? `thread:${event.thread.id}`
    : event.kind === 'conversation'
    ? `conversation:${event.items[0] ? itemKey(event.items[0]) : index}`
    : event.kind;

export function TimelineTab({
  pullRequestRef,
  pullRequest,
  order,
  onOpenCommit,
}: {
  pullRequestRef: PullRequestRef;
  pullRequest: PullRequest;
  order: 'newest' | 'oldest';
  onOpenCommit: (sha: string) => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const commits = useCommits(pullRequestRef, true);
  const reviews = useReviews(pullRequestRef, true);
  const comments = useConversationComments(pullRequestRef, true);
  const reviewComments = useReviewComments(pullRequestRef, true);
  const threads = useMemo(
    () => buildReviewThreads(reviewComments.data?.items ?? []),
    [reviewComments.data]
  );
  const events = useMemo(
    () =>
      buildTimeline(
        {
          pullRequest,
          commits: commits.data?.items ?? [],
          reviews: reviews.data?.items ?? [],
          comments: comments.data?.items ?? [],
          threads,
        },
        order
      ),
    [pullRequest, commits.data, reviews.data, comments.data, threads, order]
  );
  const queries = [commits, reviews, comments, reviewComments];
  const loading = queries.some((query) => query.isPending);
  const truncated = [commits, reviews, comments, reviewComments].find(
    (query) => query.data?.truncated
  );

  return (
    <div className="mrpr-timeline-tab">
      {queries.map((query, index) =>
        query.isError ? (
          <GitHubErrorState key={index} error={query.error} onRetry={() => void query.refetch()} />
        ) : null
      )}
      {truncated ? (
        <p className="mrpr-status mrpr-note">
          <a className="mrpr-link" href={pullRequest.url} target="_blank" rel="noopener noreferrer">
            {t('summary.truncated', { count: truncated.data?.items.length ?? 0 })}
          </a>
        </p>
      ) : null}
      {loading ? <p className="mrpr-status">{t('timeline.loading')}</p> : null}
      {events.length === 0 ? (
        loading ? null : (
          <p className="mrpr-status">{t('timeline.empty')}</p>
        )
      ) : (
        <ol className="mrpr-timeline">
          {events.map((event, index) => (
            <Event
              key={eventKey(event, index)}
              event={event}
              pullRequest={pullRequest}
              onOpenCommit={onOpenCommit}
            />
          ))}
        </ol>
      )}
    </div>
  );
}
