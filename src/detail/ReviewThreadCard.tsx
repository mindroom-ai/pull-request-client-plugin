// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestReviewAnnotation.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// A review thread as the Code tab shows it, at its line in a diff or among the conversations not on
// the current diff: how many comments it has, whether it is outdated, and each comment with its
// author, time, reactions and body. It opens expanded and folds to its heading. It only reads:
// GitHub's REST answer says nothing of a thread being resolved, and nothing here replies.
import { useState } from 'react';
import { MessageSquare } from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { PullRequestActorLabel, RelativeTime } from '../presentation';
import type { ReviewThread } from '../reviewThreads';
import { CommentBody } from './CommentBody';
import { PullRequestReactions } from './Reactions';

export function ReviewThreadCard({ thread }: { thread: ReviewThread }) {
  const t = usePluginTranslation('pull-requests');
  const [expanded, setExpanded] = useState(true);
  return (
    <div className="mrpr-thread-card">
      <div className="mrpr-thread-card-head">
        <MessageSquare aria-hidden className="mrpr-icon" />
        <button
          type="button"
          className="mrpr-thread-card-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          {t('thread.comments', { count: thread.comments.length })}
        </button>
        {thread.outdated ? <span>{t('thread.outdated')}</span> : null}
      </div>

      {expanded ? (
        <div className="mrpr-thread-card-comments">
          {thread.comments.map((comment) => {
            const time = <RelativeTime timestamp={comment.createdAt} />;
            return (
              <article key={comment.id} className="mrpr-thread-comment">
                <div className="mrpr-thread-comment-head">
                  <PullRequestActorLabel actor={comment.author} profileUrl={comment.author?.url} />
                  {comment.url ? (
                    <a
                      className="mrpr-time-link"
                      href={comment.url}
                      target="_blank"
                      rel="noopener noreferrer"
                    >
                      {time}
                    </a>
                  ) : (
                    <span className="mrpr-time-link">{time}</span>
                  )}
                  <PullRequestReactions reactions={comment.reactions} />
                </div>
                <CommentBody body={comment.body} />
              </article>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
