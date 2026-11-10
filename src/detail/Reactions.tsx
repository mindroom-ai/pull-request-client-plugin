// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestReactions.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The reactions on a comment or a description, as an emoji and a count each. GitHub's REST answer
// has no names of who reacted, so a pill has no tooltip of them, and nothing here reacts.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import type { Reaction, ReactionContent } from '../github';

const REACTIONS: Record<ReactionContent, { emoji: string; name: string }> = {
  '+1': { emoji: '👍', name: 'thumbsUp' },
  '-1': { emoji: '👎', name: 'thumbsDown' },
  laugh: { emoji: '😄', name: 'laugh' },
  hooray: { emoji: '🎉', name: 'hooray' },
  confused: { emoji: '😕', name: 'confused' },
  heart: { emoji: '❤️', name: 'heart' },
  rocket: { emoji: '🚀', name: 'rocket' },
  eyes: { emoji: '👀', name: 'eyes' },
};

export function PullRequestReactions({ reactions }: { reactions: Reaction[] }) {
  const t = usePluginTranslation('pull-requests');
  if (reactions.length === 0) return null;
  return (
    <div className="mrpr-reactions">
      {reactions.map(({ content, count }) => (
        <span
          key={content}
          role="img"
          className="mrpr-reaction"
          aria-label={t('reaction.label', {
            name: t(`reaction.name.${REACTIONS[content].name}`),
            count,
          })}
        >
          <span aria-hidden>{REACTIONS[content].emoji}</span>
          <span aria-hidden className="mrpr-tabular">
            {count}
          </span>
        </span>
      ))}
    </div>
  );
}
