// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDetail.logic.test.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { describe, expect, it } from 'vitest';

import type {
  Actor,
  CheckStatus,
  Comment,
  Commit,
  PullRequest,
  PullRequestCheck,
  Review,
  ReviewComment,
  ReviewState,
} from '../github';
import type { ReviewThread } from '../reviewThreads';
import {
  baseFreshness,
  buildTimeline,
  checksState,
  conversationItems,
  groupChecks,
  latestReviewOutcomes,
  summarizeChecks,
  type ConversationItem,
  type TimelineEvent,
} from './detail.logic';

const actor = (login: string, isBot = false): Actor => ({
  login,
  name: null,
  avatarUrl: null,
  url: null,
  isBot,
});

const review = (
  id: number,
  login: string,
  state: ReviewState,
  submittedAt: string,
  extra: Partial<Review> = {}
): Review => ({
  id,
  state,
  author: actor(login),
  body: '',
  commitId: 'head',
  submittedAt,
  url: `https://github.com/a/b/pull/1#pullrequestreview-${id}`,
  ...extra,
});

const comment = (id: number, createdAt: string, extra: Partial<Comment> = {}): Comment => ({
  id,
  author: actor('bilal'),
  body: 'looks good',
  createdAt,
  url: `https://github.com/a/b/pull/1#issuecomment-${id}`,
  reactions: [],
  ...extra,
});

const reviewComment = (
  id: number,
  createdAt: string,
  extra: Partial<ReviewComment> = {}
): ReviewComment => ({
  ...comment(id, createdAt, { body: `Current ${id}` }),
  path: 'src/a.ts',
  line: 7,
  originalLine: 7,
  side: 'RIGHT',
  inReplyToId: null,
  reviewId: null,
  outdated: true,
  commitId: 'head',
  ...extra,
});

const thread = (comments: ReviewComment[]): ReviewThread => ({
  id: comments[0]!.id,
  path: 'src/a.ts',
  line: 7,
  side: 'RIGHT',
  outdated: true,
  comments,
});

const pullRequest: PullRequest = {
  title: 'T',
  state: 'open',
  draft: false,
  body: '',
  author: actor('octocat'),
  labels: [],
  requestedReviewers: [],
  requestedTeams: [],
  mergeableState: 'clean',
  autoMerge: null,
  headSha: 'head',
  headRepo: 'a/b',
  baseRepo: 'a/b',
  mergedAt: null,
  closedAt: null,
  commentCount: 0,
  reviewCommentCount: 0,
  commitCount: 1,
  createdAt: '2026-07-01T00:00:00Z',
  updatedAt: '2026-07-01T00:00:00Z',
  baseRef: 'main',
  headRef: 'topic',
  additions: 0,
  deletions: 0,
  changedFiles: 0,
  url: 'https://github.com/a/b/pull/1',
};

const commit: Commit = {
  sha: '1baf7bdcafe',
  headline: 'add the page',
  author: actor('octocat'),
  authorName: 'Octo Cat',
  committedAt: '2026-07-02T00:00:00Z',
  url: 'https://github.com/a/b/commit/1baf7bdcafe',
};

const TIMELINE_SOURCE = {
  pullRequest,
  commits: [commit],
  reviews: [] as Review[],
  comments: [comment(1, '2026-07-03T00:00:00Z')],
  threads: [] as ReviewThread[],
};

const itemKey = (item: ConversationItem): string =>
  item.kind === 'comment'
    ? `comment:${item.comment.id}`
    : item.kind === 'review'
    ? `review:${item.review.id}`
    : `thread:${item.thread.id}`;

const eventKey = (event: TimelineEvent): string | string[] => {
  switch (event.kind) {
    case 'commit':
      return `commit:${event.commit.sha}`;
    case 'verdict':
      return `verdict:${event.review.id}`;
    case 'thread':
      return `thread:${event.thread.id}`;
    case 'conversation':
      return ['conversation', ...event.items.map(itemKey)];
    default:
      return event.kind;
  }
};

describe('latestReviewOutcomes', () => {
  it("keeps each reviewer's last word, whatever order the host returned them in", () => {
    expect(
      latestReviewOutcomes(
        [
          review(3, 'bilal', 'APPROVED', '2026-07-03T00:00:00Z'),
          review(1, 'bilal', 'CHANGES_REQUESTED', '2026-07-01T00:00:00Z'),
          review(2, 'octocat', 'CHANGES_REQUESTED', '2026-07-02T00:00:00Z'),
          review(4, 'octocat', 'COMMENTED', '2026-07-04T00:00:00Z'),
        ],
        'head'
      ).map((entry) => [entry.login, entry.actor?.login, entry.verdict, entry.review.id])
    ).toEqual([
      ['bilal', 'bilal', 'approved', 3],
      ['octocat', 'octocat', 'changes-requested', 2],
    ]);
  });

  it('latestReviewOutcomes marks a review of an older commit stale', () => {
    const approval = review(1, 'bilal', 'APPROVED', '2026-07-01T00:00:00Z', { commitId: 'old' });
    expect(latestReviewOutcomes([approval], 'head')[0]?.stale).toBe(true);
    expect(latestReviewOutcomes([{ ...approval, commitId: 'head' }], 'head')[0]?.stale).toBe(false);
    // A head that is not known yet makes no verdict stale.
    expect(latestReviewOutcomes([approval], '')[0]?.stale).toBe(false);
  });

  it('orders instants rather than their text, so a UTC offset cannot invert them', () => {
    expect(
      latestReviewOutcomes(
        [
          review(1, 'bilal', 'APPROVED', '2026-07-05T00:30:00Z'),
          // 2026-07-04T23:00:00Z, earlier than the approval although its text sorts after it.
          review(2, 'bilal', 'CHANGES_REQUESTED', '2026-07-05T01:00:00+02:00'),
        ],
        'head'
      ).map((entry) => entry.verdict)
    ).toEqual(['approved']);
  });

  it('a later dismissal removes the verdict', () => {
    expect(
      latestReviewOutcomes(
        [
          review(1, 'bilal', 'APPROVED', '2026-07-01T00:00:00Z'),
          review(2, 'bilal', 'DISMISSED', '2026-07-02T00:00:00Z'),
        ],
        'head'
      )
    ).toEqual([]);
    expect(
      latestReviewOutcomes(
        [
          review(1, 'bilal', 'DISMISSED', '2026-07-01T00:00:00Z'),
          review(2, 'bilal', 'APPROVED', '2026-07-02T00:00:00Z'),
        ],
        'head'
      ).map((entry) => entry.verdict)
    ).toEqual(['approved']);
  });

  it('keeps the verdicts of reviews without an author apart', () => {
    const ghost = (id: number) => ({
      ...review(id, '', 'APPROVED', '2026-07-01T00:00:00Z'),
      author: null,
    });
    expect(
      latestReviewOutcomes([ghost(1), ghost(2)], 'head').map((entry) => [entry.login, entry.actor])
    ).toEqual([
      ['ghost:1', null],
      ['ghost:2', null],
    ]);
  });
});

describe('checks', () => {
  const check = (status: CheckStatus, url: string | null = null): PullRequestCheck => ({
    name: status,
    status,
    description: null,
    url,
    updatedAt: null,
  });
  const run = 'https://github.com/a/b/actions/runs/12/job/34';

  it('classifies checks: failing over pending over passing', () => {
    expect(checksState([])).toBe('none');
    expect(checksState([check('success'), check('cancelled'), check('pending')])).toBe('failing');
    expect(checksState([check('success'), check('failure')])).toBe('failing');
    expect(checksState([check('success'), check('action-required')])).toBe('pending');
    expect(checksState([check('success'), check('pending')])).toBe('pending');
    expect(checksState([check('success'), check('skipped'), check('neutral')])).toBe('passing');
  });

  it('summarizes failing first, then awaiting action, then running', () => {
    expect(summarizeChecks([])).toBe('No checks reported');
    expect(
      summarizeChecks([check('failure'), check('cancelled'), check('pending'), check('success')])
    ).toBe('2 of 4 failing');
    expect(summarizeChecks([check('pending'), check('success'), check('pending')])).toBe(
      '2 of 3 running'
    );
    expect(summarizeChecks([check('action-required'), check('pending')])).toBe(
      '1 check awaiting action'
    );
    expect(summarizeChecks([check('action-required', run), check('action-required', run)])).toBe(
      '2 workflows awaiting approval'
    );
    expect(summarizeChecks([check('action-required', run), check('action-required')])).toBe(
      '1 workflow and 1 check awaiting action'
    );
    expect(summarizeChecks([check('success'), check('success')])).toBe('All checks have passed');
    expect(summarizeChecks([check('success'), check('skipped'), check('neutral')])).toBe(
      '1 of 3 passing'
    );
  });

  it('groups checks that need attention, running ones and completed ones', () => {
    const checks = [
      check('success'),
      check('failure'),
      check('pending'),
      check('cancelled'),
      check('skipped'),
      check('action-required'),
      check('neutral'),
    ];
    const groups = groupChecks(checks);
    expect(groups.attention.map((c) => c.status)).toEqual([
      'failure',
      'cancelled',
      'action-required',
    ]);
    expect(groups.running.map((c) => c.status)).toEqual(['pending']);
    expect(groups.completed.map((c) => c.status)).toEqual(['success', 'skipped', 'neutral']);
  });
});

describe('conversationItems', () => {
  const finding = reviewComment(10, '2026-07-02T12:00:00Z', { author: actor('review[bot]', true) });
  const reply = reviewComment(11, '2026-07-04T12:00:00Z', { inReplyToId: 10 });
  const lastReply = reviewComment(12, '2026-07-06T12:00:00Z', { inReplyToId: 10 });
  const findingThread = thread([finding, reply, lastReply]);

  it('orders whole conversations by their first time, newest or oldest first', () => {
    const earlier = comment(2, '2026-07-01T00:00:00Z');
    const remark = review(20, 'octocat', 'COMMENTED', '2026-07-05T00:00:00Z', { body: 'Nit' });
    const items = (order: 'newest' | 'oldest') =>
      conversationItems(
        [comment(1, '2026-07-03T00:00:00Z'), earlier],
        [remark],
        [findingThread],
        order
      ).map(itemKey);
    expect(items('oldest')).toEqual(['comment:2', 'thread:10', 'comment:1', 'review:20']);
    expect(items('newest')).toEqual(['review:20', 'comment:1', 'thread:10', 'comment:2']);
  });

  it('conversationItems leaves out reviews without a body', () => {
    const items = conversationItems(
      [],
      [
        review(1, 'bilal', 'APPROVED', '2026-07-01T00:00:00Z'),
        review(2, 'bilal', 'COMMENTED', '2026-07-02T00:00:00Z', { body: '  \n' }),
        review(3, 'bilal', 'CHANGES_REQUESTED', '2026-07-03T00:00:00Z', { body: 'Needs a test.' }),
      ],
      [],
      'oldest'
    );
    expect(items.map(itemKey)).toEqual(['review:3']);
  });

  it('keeps the thread with its own comments, at its first comment', () => {
    const [item] = conversationItems([], [], [findingThread], 'newest');
    expect(item).toEqual({ kind: 'thread', thread: findingThread });
  });
});

describe('buildTimeline', () => {
  it('orders host timestamps by instant across offsets and fractional seconds', () => {
    const events = buildTimeline(
      {
        ...TIMELINE_SOURCE,
        pullRequest: { ...pullRequest, createdAt: '2026-07-05T01:00:00+02:00' },
        commits: [{ ...commit, sha: 'commit', committedAt: '2026-07-05T00:30:00Z' }],
        comments: [comment(1, '2026-07-05T00:30:00.5Z')],
      },
      'newest'
    );
    expect(events.map(eventKey)).toEqual([
      ['conversation', 'comment:1'],
      'commit:commit',
      'opened',
    ]);
  });

  it('merged wins over closed', () => {
    const events = buildTimeline(
      {
        ...TIMELINE_SOURCE,
        pullRequest: {
          ...pullRequest,
          state: 'merged',
          mergedAt: '2026-07-04T00:00:00Z',
          closedAt: '2026-07-04T00:00:00Z',
        },
      },
      'newest'
    );
    expect(events[0]).toEqual({ kind: 'merged', at: '2026-07-04T00:00:00Z', actor: null });
    expect(events.some((event) => event.kind === 'closed')).toBe(false);
    const closed = buildTimeline(
      {
        ...TIMELINE_SOURCE,
        pullRequest: { ...pullRequest, state: 'closed', closedAt: '2026-07-04T00:00:00Z' },
      },
      'newest'
    );
    expect(closed.map((event) => event.kind)).toEqual([
      'closed',
      'conversation',
      'commit',
      'opened',
    ]);
    expect(closed.at(-1)).toEqual({
      kind: 'opened',
      at: '2026-07-01T00:00:00Z',
      actor: pullRequest.author,
    });
  });

  it('groups conversation sections without crossing commits or the pull request updates', () => {
    const events = buildTimeline(
      {
        ...TIMELINE_SOURCE,
        pullRequest: { ...pullRequest, state: 'merged', mergedAt: '2026-07-05T00:00:00Z' },
        comments: [
          comment(1, '2026-07-04T00:00:00Z'),
          comment(2, '2026-07-03T00:00:00Z'),
          comment(3, '2026-07-01T12:00:00Z'),
          comment(4, '2026-07-01T06:00:00Z'),
        ],
      },
      'newest'
    );
    expect(events.map(eventKey)).toEqual([
      'merged',
      ['conversation', 'comment:1', 'comment:2'],
      'commit:1baf7bdcafe',
      ['conversation', 'comment:3', 'comment:4'],
      'opened',
    ]);
    expect(events[1]?.at).toBe('2026-07-04T00:00:00Z');
  });

  it('buildTimeline groups adjacent plain comments and keeps verdicts apart', () => {
    const input = {
      ...TIMELINE_SOURCE,
      comments: [comment(1, '2026-07-05T00:00:00Z'), comment(2, '2026-07-03T00:00:00Z')],
      reviews: [
        review(10, 'bilal', 'APPROVED', '2026-07-04T00:00:00Z'),
        review(11, 'bilal', 'COMMENTED', '2026-07-02T12:00:00Z', { body: 'One remark' }),
        // A bodiless remark only holds line comments, which come as threads.
        review(12, 'bilal', 'COMMENTED', '2026-07-02T13:00:00Z'),
        review(13, 'bilal', 'DISMISSED', '2026-07-01T12:00:00Z'),
      ],
    };
    expect(buildTimeline(input, 'newest').map(eventKey)).toEqual([
      ['conversation', 'comment:1'],
      'verdict:10',
      ['conversation', 'comment:2', 'review:11'],
      'commit:1baf7bdcafe',
      'verdict:13',
      'opened',
    ]);
    expect(buildTimeline(input, 'oldest').map(eventKey)).toEqual([
      'opened',
      'verdict:13',
      'commit:1baf7bdcafe',
      ['conversation', 'review:11', 'comment:2'],
      'verdict:10',
      ['conversation', 'comment:1'],
    ]);
  });

  it('keeps a finding and its replies in one event at the finding time', () => {
    const finding = reviewComment(10, '2026-07-02T12:00:00Z');
    const findingThread = thread([
      finding,
      reviewComment(11, '2026-07-04T12:00:00Z', { inReplyToId: 10 }),
      reviewComment(12, '2026-07-06T12:00:00Z', { inReplyToId: 10 }),
    ]);
    const events = buildTimeline({ ...TIMELINE_SOURCE, threads: [findingThread] }, 'newest');
    expect(events.map(eventKey)).toEqual([
      ['conversation', 'comment:1'],
      'thread:10',
      'commit:1baf7bdcafe',
      'opened',
    ]);
    expect(events[1]).toEqual({ kind: 'thread', at: finding.createdAt, thread: findingThread });
  });

  it('starts with the opening alone', () => {
    expect(
      buildTimeline({ ...TIMELINE_SOURCE, commits: [], comments: [] }, 'newest').map(eventKey)
    ).toEqual(['opened']);
  });
});

describe('baseFreshness', () => {
  it('says nothing where the branch is current or was not compared', () => {
    expect(baseFreshness(undefined, 'clean')).toBeUndefined();
    expect(baseFreshness(0, 'clean')).toBeUndefined();
    expect(baseFreshness(undefined, null)).toBeUndefined();
  });

  it('counts the commits behind', () => {
    expect(baseFreshness(3, 'behind')).toEqual({ behind: 3, conflicts: false });
    expect(baseFreshness(3, 'dirty')).toEqual({ behind: 3, conflicts: true });
  });

  it('baseFreshness with conflicts and no lag', () => {
    expect(baseFreshness(0, 'dirty')).toEqual({ behind: 0, conflicts: true });
    expect(baseFreshness(undefined, 'dirty')).toEqual({ behind: 0, conflicts: true });
  });
});
