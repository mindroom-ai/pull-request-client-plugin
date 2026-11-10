// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDetail.logic.ts and pullRequestPresentation.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// What the panel makes of a pull request's reviews, checks, comments and commits: each reviewer's
// verdict, the checks' state and summary, the Summary tab's conversations, the Timeline tab's
// events and how the branch stands against its base.
import type {
  Actor,
  Comment,
  Commit,
  PullRequest,
  PullRequestCheck,
  Review,
  ReviewState,
} from '../github';
import type { ReviewThread } from '../reviewThreads';

// Host UTC offsets make lexical timestamp sorting unsafe.
function instant(iso: string): number {
  return Date.parse(iso);
}

export type Outcome = 'approved' | 'changes-requested' | 'dismissed';

// The reviews that are verdicts; a comment-only review is none.
const REVIEW_OUTCOMES: Record<ReviewState, Outcome | null> = {
  APPROVED: 'approved',
  CHANGES_REQUESTED: 'changes-requested',
  DISMISSED: 'dismissed',
  COMMENTED: null,
};

/** The verdict a review gives, or null for a comment-only review. */
export const reviewOutcome = (state: ReviewState): Outcome | null => REVIEW_OUTCOMES[state];

export type ReviewOutcome = {
  login: string;
  actor: Actor | null;
  verdict: 'approved' | 'changes-requested';
  stale: boolean;
  review: Review;
};

/**
 * Each reviewer's last word: their latest approval or change request, or nothing when their latest
 * such review was dismissed. Comment-only reviews give no verdict. A verdict is stale when it was
 * given on another commit than the head. A review without an author is keyed `ghost:<review id>`.
 */
export function latestReviewOutcomes(reviews: Review[], headSha: string): ReviewOutcome[] {
  const latest = new Map<string, { review: Review; outcome: Outcome }>();
  for (const review of reviews) {
    const outcome = REVIEW_OUTCOMES[review.state];
    if (outcome === null) continue;
    const login = review.author?.login || `ghost:${review.id}`;
    const current = latest.get(login);
    // Hosts can return reviews out of order.
    if (
      current !== undefined &&
      instant(current.review.submittedAt) > instant(review.submittedAt)
    ) {
      continue;
    }
    latest.set(login, { review, outcome });
  }
  return [...latest.entries()].flatMap(([login, { review, outcome }]) =>
    outcome === 'dismissed'
      ? []
      : [
          {
            login,
            actor: review.author,
            verdict: outcome,
            // A head that is not known yet makes no verdict stale.
            stale: headSha !== '' && review.commitId !== headSha,
            review,
          },
        ]
  );
}

export type ChecksState = 'none' | 'passing' | 'failing' | 'pending';

/** The checks taken together: failing over pending over passing. */
export function checksState(checks: PullRequestCheck[]): ChecksState {
  if (checks.length === 0) return 'none';
  if (checks.some((check) => check.status === 'failure' || check.status === 'cancelled')) {
    return 'failing';
  }
  if (checks.some((check) => check.status === 'pending' || check.status === 'action-required')) {
    return 'pending';
  }
  return 'passing';
}

export function isWorkflowApprovalCheck(check: Pick<PullRequestCheck, 'status' | 'url'>): boolean {
  return (
    check.status === 'action-required' &&
    check.url !== null &&
    /\/actions\/runs\/\d+(?:\/|$)/u.test(check.url)
  );
}

export type ChecksSummaryKey =
  | 'none'
  | 'failing'
  | 'oneWorkflowAndChecksAwaitingAction'
  | 'workflowsAndChecksAwaitingAction'
  | 'workflowsAwaitingApproval'
  | 'checksAwaitingAction'
  | 'running'
  | 'allPassed'
  | 'passing';

/**
 * The checks' summary line as the key of its text under `checks` in the plugin's strings, with the
 * numbers the text needs: `total` checks, `count` of them that the text is about (failing, awaiting
 * action that is not a workflow approval, running or passing; workflows awaiting approval for
 * `workflowsAwaitingApproval`), and the `workflows` awaiting approval.
 */
export type ChecksSummary = {
  key: ChecksSummaryKey;
  count: number;
  total: number;
  workflows: number;
};

/** What the checks line says: what fails, else what waits for someone, else what runs. */
export function summarizeChecks(checks: PullRequestCheck[]): ChecksSummary {
  const total = checks.length;
  const actionRequired = checks.filter((check) => check.status === 'action-required');
  const workflows = actionRequired.filter(isWorkflowApprovalCheck).length;
  const otherActionRequired = actionRequired.length - workflows;
  const failed = checks.filter(
    (check) => check.status === 'failure' || check.status === 'cancelled'
  ).length;
  const pending = checks.filter((check) => check.status === 'pending').length;
  const passed = checks.filter((check) => check.status === 'success').length;
  const summary = (key: ChecksSummaryKey, count: number) => ({ key, count, total, workflows });
  if (total === 0) return summary('none', 0);
  if (failed > 0) return summary('failing', failed);
  // i18next plurals follow one count, so the number of workflows picks the key, as the app's
  // own strings do for a second count.
  if (workflows > 0 && otherActionRequired > 0) {
    return summary(
      workflows === 1 ? 'oneWorkflowAndChecksAwaitingAction' : 'workflowsAndChecksAwaitingAction',
      otherActionRequired
    );
  }
  if (workflows > 0) return summary('workflowsAwaitingApproval', workflows);
  if (otherActionRequired > 0) return summary('checksAwaitingAction', otherActionRequired);
  if (pending > 0) return summary('running', pending);
  return summary(passed === total ? 'allPassed' : 'passing', passed);
}

export function groupChecks(checks: PullRequestCheck[]): {
  attention: PullRequestCheck[];
  running: PullRequestCheck[];
  completed: PullRequestCheck[];
} {
  return {
    attention: checks.filter((check) =>
      ['failure', 'cancelled', 'action-required'].includes(check.status)
    ),
    running: checks.filter((check) => check.status === 'pending'),
    completed: checks.filter((check) => ['success', 'skipped', 'neutral'].includes(check.status)),
  };
}

export type ConversationItem =
  | { kind: 'comment'; comment: Comment }
  | { kind: 'review'; review: Review }
  | { kind: 'thread'; thread: ReviewThread };

function conversationItemAt(item: ConversationItem): string {
  if (item.kind === 'comment') return item.comment.createdAt;
  if (item.kind === 'review') return item.review.submittedAt;
  return item.thread.comments[0]?.createdAt ?? '';
}

const byTime = (left: ConversationItem, right: ConversationItem) =>
  instant(conversationItemAt(left)) - instant(conversationItemAt(right));

// A review without a body only holds line comments, which come as threads, or a verdict, which
// the reviewers row and the timeline's verdicts show.
const hasBody = (review: Review) => review.body.trim().length > 0;

/**
 * The Summary tab's conversations: the comments, the reviews written with a body, and the review
 * threads, each thread whole at the time of its first comment, oldest first or newest first.
 */
export function conversationItems(
  comments: Comment[],
  reviews: Review[],
  threads: ReviewThread[],
  order: 'newest' | 'oldest'
): ConversationItem[] {
  const loose: ConversationItem[] = [
    ...comments.map((comment): ConversationItem => ({ kind: 'comment', comment })),
    ...reviews.filter(hasBody).map((review): ConversationItem => ({ kind: 'review', review })),
  ].sort(byTime);
  const threadItems = threads
    .filter((thread) => thread.comments.length > 0)
    .map((thread): ConversationItem => ({ kind: 'thread', thread }))
    .sort(byTime);
  const items: ConversationItem[] = [];
  let next = 0;
  // Each thread goes in at its finding's time, before the loose items written after it.
  for (const item of loose) {
    while (next < threadItems.length && byTime(threadItems[next]!, item) < 0) {
      items.push(threadItems[next++]!);
    }
    items.push(item);
  }
  items.push(...threadItems.slice(next));
  return order === 'newest' ? items.reverse() : items;
}

export type TimelineEvent =
  | { kind: 'opened' | 'merged' | 'closed'; at: string; actor: Actor | null }
  | { kind: 'commit'; at: string; commit: Commit }
  | { kind: 'verdict'; at: string; review: Review }
  | { kind: 'thread'; at: string; thread: ReviewThread }
  | { kind: 'conversation'; at: string; items: ConversationItem[] };

// An event as the timeline sorts it, or an item of a conversation before runs are grouped.
type TimelineEntry =
  | Exclude<TimelineEvent, { kind: 'conversation' }>
  | { at: string; item: ConversationItem };

function reviewEntries(review: Review): TimelineEntry[] {
  if (REVIEW_OUTCOMES[review.state] !== null) {
    return [{ kind: 'verdict', at: review.submittedAt, review }];
  }
  return hasBody(review) ? [{ at: review.submittedAt, item: { kind: 'review', review } }] : [];
}

function threadEntries(thread: ReviewThread): TimelineEntry[] {
  const root = thread.comments[0];
  return root ? [{ kind: 'thread', at: root.createdAt, thread }] : [];
}

function endEntries(pullRequest: PullRequest): TimelineEntry[] {
  if (pullRequest.mergedAt) return [{ kind: 'merged', at: pullRequest.mergedAt, actor: null }];
  if (pullRequest.closedAt) return [{ kind: 'closed', at: pullRequest.closedAt, actor: null }];
  return [];
}

/**
 * The Timeline tab's events in time order: the opening, each commit, each verdict (approved,
 * changes requested or dismissed), each review thread at its first comment, and the merge or the
 * close. Merged wins over closed: GitHub sets both timestamps on a merge, and reporting "closed"
 * for a merged pull request would misstate what happened. A run of plain comments and remarks
 * (comment-only reviews with a body) between two other events is one conversation event, at the
 * time of its first item in the order shown.
 */
export function buildTimeline(
  input: {
    pullRequest: PullRequest;
    commits: Commit[];
    reviews: Review[];
    comments: Comment[];
    threads: ReviewThread[];
  },
  order: 'newest' | 'oldest'
): TimelineEvent[] {
  const { pullRequest } = input;
  const entries: TimelineEntry[] = [
    { kind: 'opened', at: pullRequest.createdAt, actor: pullRequest.author },
    ...input.commits.map(
      (commit): TimelineEntry => ({ kind: 'commit', at: commit.committedAt, commit })
    ),
    ...input.comments.map(
      (comment): TimelineEntry => ({
        at: comment.createdAt,
        item: { kind: 'comment', comment },
      })
    ),
    ...input.reviews.flatMap(reviewEntries),
    ...input.threads.flatMap(threadEntries),
    ...endEntries(pullRequest),
  ];
  const newestFirst = entries.sort(
    (left, right) => (instant(right.at) || 0) - (instant(left.at) || 0)
  );
  const ordered = order === 'newest' ? newestFirst : newestFirst.reverse();
  const events: TimelineEvent[] = [];
  for (const entry of ordered) {
    if (!('item' in entry)) {
      events.push(entry);
      continue;
    }
    const last = events.at(-1);
    if (last?.kind === 'conversation') last.items.push(entry.item);
    else events.push({ kind: 'conversation', at: entry.at, items: [entry.item] });
  }
  return events;
}

/**
 * How the branch stands against its base: the commits it is behind, and whether it conflicts
 * (GitHub's `mergeable_state` `dirty`). Undefined when it is neither behind nor conflicting, or
 * when the comparison has not loaded and nothing conflicts.
 */
export function baseFreshness(
  behindBy: number | undefined,
  mergeableState: string | null
): { behind: number; conflicts: boolean } | undefined {
  const behind = behindBy ?? 0;
  const conflicts = mergeableState === 'dirty';
  return behind > 0 || conflicts ? { behind, conflicts } : undefined;
}

/** A body that is only HTML comments (a bot's markers) and whitespace is empty; any other is kept. */
export function visibleBody(body: string): string | null {
  return body.replace(/<!--[\s\S]*?-->/gu, '').trim().length === 0 ? null : body.trim();
}
