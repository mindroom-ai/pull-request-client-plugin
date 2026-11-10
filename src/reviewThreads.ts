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
 * Review comments grouped into threads: a root comment and its replies, replies in time order. A
 * reply joins the thread of the comment its `inReplyToId` chain leads to: the chain's root, or,
 * when the root is missing (not loaded), the first loaded comment of the chain, which roots a
 * thread of its own. A comment whose chain loops roots a thread of its own, so no comment is
 * lost. Threads follow the time of their root.
 */
export function buildReviewThreads(comments: ReviewComment[]): ReviewThread[] {
  const byId = new Map(comments.map((c) => [c.id, c]));
  const rootOf = (c: ReviewComment): ReviewComment => {
    const seen = new Set([c.id]);
    let current = c;
    while (current.inReplyToId !== null) {
      const parent = byId.get(current.inReplyToId);
      if (!parent) return current;
      if (seen.has(parent.id)) return c;
      seen.add(parent.id);
      current = parent;
    }
    return current;
  };
  const replies = new Map<number, ReviewComment[]>();
  const roots: ReviewComment[] = [];
  for (const c of comments) {
    const root = rootOf(c);
    if (root === c) roots.push(c);
    else replies.set(root.id, [...(replies.get(root.id) ?? []), c]);
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
