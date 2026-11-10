// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestSummaryTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The cards of the Summary and Timeline tabs: one comment, and a conversation item (a comment, a
// review with a body, or a review thread whole).
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import type { Actor, Reaction } from '../github';
import {
  PullRequestActorLabel,
  PullRequestReviewOutcomeBadge,
  RelativeTime,
} from '../presentation';
import { CommentBody } from './CommentBody';
import { reviewOutcome, type ConversationItem, type Outcome } from './detail.logic';
import { PullRequestReactions } from './Reactions';

type CardData = {
  author: Actor | null;
  at: string;
  url: string;
  body: string;
  reactions: Reaction[];
  outcome: Outcome | null;
};

/** One comment: who and when (linking to it on GitHub), the verdict of a review, reactions, body. */
export function CommentCard({
  card,
  location,
}: {
  card: CardData;
  location?: { path: string; line: number | null; outdated: boolean };
}) {
  const t = usePluginTranslation('pull-requests');
  const time = <RelativeTime timestamp={card.at} />;
  return (
    <article className="mrpr-comment-card">
      <div className="mrpr-comment-head">
        <PullRequestActorLabel actor={card.author} profileUrl={card.author?.url} />
        {card.url ? (
          <a className="mrpr-time-link" href={card.url} target="_blank" rel="noopener noreferrer">
            {time}
          </a>
        ) : (
          <span className="mrpr-time-link">{time}</span>
        )}
        {card.outcome ? <PullRequestReviewOutcomeBadge outcome={card.outcome} /> : null}
        <PullRequestReactions reactions={card.reactions} />
      </div>
      {location ? (
        <div className="mrpr-comment-location">
          <span className="mrpr-truncate mrpr-mono">
            {location.path}
            {location.line ? `:${location.line}` : ''}
          </span>
          {location.outdated ? (
            <span className="mrpr-shrink-0">{t('summary.outdated')}</span>
          ) : null}
        </div>
      ) : null}
      <CommentBody body={card.body} />
    </article>
  );
}

export function ConversationCard({ item }: { item: ConversationItem }) {
  if (item.kind === 'comment') {
    const { comment } = item;
    return (
      <CommentCard
        card={{
          author: comment.author,
          at: comment.createdAt,
          url: comment.url,
          body: comment.body,
          reactions: comment.reactions,
          outcome: null,
        }}
      />
    );
  }
  if (item.kind === 'review') {
    const { review } = item;
    return (
      <CommentCard
        card={{
          author: review.author,
          at: review.submittedAt,
          url: review.url,
          body: review.body,
          reactions: [],
          outcome: reviewOutcome(review.state),
        }}
      />
    );
  }
  const { thread } = item;
  const [root, ...replies] = thread.comments;
  if (!root) return null;
  const card = (comment: typeof root): CardData => ({
    author: comment.author,
    at: comment.createdAt,
    url: comment.url,
    body: comment.body,
    reactions: comment.reactions,
    outcome: null,
  });
  return (
    <div className="mrpr-thread">
      <CommentCard
        card={card(root)}
        location={{ path: thread.path, line: thread.line, outdated: thread.outdated }}
      />
      {replies.length > 0 ? (
        <div className="mrpr-replies">
          {replies.map((reply) => (
            <CommentCard key={reply.id} card={card(reply)} />
          ))}
        </div>
      ) : null}
    </div>
  );
}
