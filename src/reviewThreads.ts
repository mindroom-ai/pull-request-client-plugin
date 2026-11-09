import type { ReviewComment } from './github';

export type ReviewThread = {
  id: number;
  path: string;
  line: number | null;
  side: 'LEFT' | 'RIGHT';
  outdated: boolean;
  comments: ReviewComment[];
};

const byTime = (a: ReviewComment, b: ReviewComment) =>
  a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : a.id - b.id;

/**
 * Review comments grouped into threads: a root comment and its replies by `inReplyToId`, replies
 * in time order. A reply whose root is missing (not loaded) is a thread of its own. Threads follow
 * the time of their root.
 */
export function buildReviewThreads(comments: ReviewComment[]): ReviewThread[] {
  const ids = new Set(comments.map((c) => c.id));
  const replies = new Map<number, ReviewComment[]>();
  const roots: ReviewComment[] = [];
  for (const c of comments) {
    if (c.inReplyToId !== null && ids.has(c.inReplyToId)) {
      replies.set(c.inReplyToId, [...(replies.get(c.inReplyToId) ?? []), c]);
    } else {
      roots.push(c);
    }
  }
  return roots.sort(byTime).map((root) => ({
    id: root.id,
    path: root.path,
    line: root.line ?? root.originalLine,
    side: root.side,
    outdated: root.outdated,
    comments: [root, ...(replies.get(root.id) ?? []).sort(byTime)],
  }));
}
