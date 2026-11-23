import { describe, expect, it } from 'vitest';

import type { PullRequest, Repository } from '../github';
import {
  canDeleteBranch,
  mayDeleteBranch,
  menuActions,
  primaryControl,
  resolveMergeMethod,
  showsOutcome,
} from './actions.logic';

const pullRequest: PullRequest = {
  title: 'T',
  state: 'open',
  draft: false,
  body: '',
  images: { byUrl: {}, byAttachment: {} },
  author: null,
  labels: [],
  requestedReviewers: [],
  requestedTeams: [],
  nodeId: 'PR_node',
  mergeable: true,
  mergeableState: 'clean',
  autoMerge: null,
  headSha: 'head',
  headRepo: 'a/b',
  headRepoId: 'R_ab',
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

const repository: Repository = {
  canWrite: true,
  mergeMethods: ['squash', 'merge', 'rebase'],
  autoMergeAllowed: true,
  defaultBranch: 'main',
};

const pr = (extra: Partial<PullRequest>): PullRequest => ({ ...pullRequest, ...extra });
const repo = (extra: Partial<Repository>): Repository => ({ ...repository, ...extra });
const armed = { autoMerge: { method: 'squash' as const } };
// What GitHub does not merge yet: a required check still runs, or a review is missing.
const blocked = { mergeableState: 'blocked' };

describe('primaryControl', () => {
  it('waits while GitHub still checks whether it merges, and acts on what it found after', () => {
    const unknown = pr({ mergeable: null, mergeableState: 'unknown' });
    expect(primaryControl(unknown, repository, 'passing', true)).toBe('checking');
    expect(primaryControl(unknown, repository, 'pending', true)).toBe('checking');
    expect(menuActions(unknown, repository, 'checking', undefined)).toEqual(['draft', 'close']);
    // Once the tries are spent, as before.
    expect(primaryControl(unknown, repository, 'passing', false)).toBe('merge');
    // What does not depend on it does not wait.
    expect(primaryControl(pr({ mergeable: null, draft: true }), repository, 'passing', true)).toBe(
      'ready'
    );
    expect(primaryControl(pr({ mergeable: null, ...armed }), repository, 'passing', true)).toBe(
      'auto-merge-armed'
    );
  });

  it('shows a merged pull request as merged', () => {
    expect(primaryControl(pr({ state: 'merged' }), repository, 'passing')).toBe('merged');
  });

  it('shows a closed pull request as closed', () => {
    expect(primaryControl(pr({ state: 'closed' }), repository, 'passing')).toBe('closed');
  });

  it('shows conflicts over a draft', () => {
    expect(
      primaryControl(pr({ mergeableState: 'dirty', draft: true }), repository, 'passing')
    ).toBe('conflicts');
  });

  it('offers a draft as ready with write access', () => {
    expect(primaryControl(pr({ draft: true }), repository, 'passing')).toBe('ready');
  });

  it('offers nothing on a draft without write access', () => {
    expect(primaryControl(pr({ draft: true }), repo({ canWrite: false }), 'passing')).toBeNull();
  });

  it('shows armed auto-merge', () => {
    expect(primaryControl(pr(armed), repository, 'pending')).toBe('auto-merge-armed');
  });

  it('offers nothing when the repository allows no merge method', () => {
    expect(primaryControl(pullRequest, repo({ mergeMethods: [] }), 'passing')).toBeNull();
  });

  it('offers auto-merge while checks are pending and the repository allows it', () => {
    expect(primaryControl(pr(blocked), repository, 'pending')).toBe('enable-auto-merge');
    expect(primaryControl(pr(blocked), repository, 'failing')).toBe('enable-auto-merge');
  });

  // GitHub refuses to arm auto-merge on a pull request it can merge at once.
  it.each(['clean', 'has_hooks', 'unstable'])(
    'offers merge, not auto-merge, on a pull request GitHub can merge now (%s)',
    (mergeableState) => {
      expect(primaryControl(pr({ mergeableState }), repository, 'pending')).toBe('merge');
      expect(primaryControl(pr({ mergeableState }), repository, 'failing')).toBe('merge');
    }
  );

  it('offers merge on failing checks when the repository allows no auto-merge', () => {
    expect(primaryControl(pr(blocked), repo({ autoMergeAllowed: false }), 'failing')).toBe('merge');
  });

  it('counts checks not loaded yet, or none at all, as passing', () => {
    expect(primaryControl(pullRequest, repository, undefined)).toBe('merge');
    expect(primaryControl(pullRequest, repository, 'none')).toBe('merge');
  });

  it('offers no merge without write access', () => {
    expect(primaryControl(pullRequest, repo({ canWrite: false }), 'passing')).toBeNull();
  });
});

describe('resolveMergeMethod', () => {
  it('takes the chosen method over last and default', () => {
    expect(resolveMergeMethod(['squash', 'merge', 'rebase'], 'merge', 'rebase')).toBe('merge');
    expect(resolveMergeMethod(['merge', 'squash'], 'squash', 'merge')).toBe('squash');
  });

  it('falls to the last method over the default when the chosen one is not allowed', () => {
    expect(resolveMergeMethod(['squash', 'merge'], 'rebase', 'merge')).toBe('merge');
    expect(resolveMergeMethod(['squash', 'merge', 'rebase'], null, 'rebase')).toBe('rebase');
  });

  it('prefers squash when neither chosen nor last is allowed, even if merge comes first', () => {
    expect(resolveMergeMethod(['merge', 'squash', 'rebase'], null, null)).toBe('squash');
    expect(resolveMergeMethod(['merge', 'squash'], 'rebase', null)).toBe('squash');
  });

  it("falls to the repository's first method when squash is not allowed", () => {
    expect(resolveMergeMethod(['merge', 'rebase'], null, null)).toBe('merge');
    expect(resolveMergeMethod(['rebase'], null, 'squash')).toBe('rebase');
  });

  it('is null when the repository allows none', () => {
    expect(resolveMergeMethod([], 'merge', 'merge')).toBeNull();
  });
});

describe('showsOutcome', () => {
  it.each([
    ['merge', { state: 'merged' }, {}],
    ['close', { state: 'closed' }, {}],
    ['reopen', {}, { state: 'closed' }],
    ['ready', {}, { draft: true }],
    ['draft', { draft: true }, {}],
    ['enable-auto-merge', armed, {}],
    ['disable-auto-merge', {}, armed],
  ] as const)(
    '%s shows on the pull request it changed, not on the one before',
    (action, after, before) => {
      expect(showsOutcome(pr(after), action)).toBe(true);
      expect(showsOutcome(pr(before), action)).toBe(false);
    }
  );

  it('auto-merge that merged at once shows as the merge', () => {
    expect(showsOutcome(pr({ state: 'merged' }), 'enable-auto-merge')).toBe(true);
  });

  it.each(['delete-branch', 'update-branch', 'update-branch-rebase'] as const)(
    '%s shows nowhere on the pull request',
    (action) => {
      expect(showsOutcome(pullRequest, action)).toBe(false);
      expect(showsOutcome(pr({ state: 'merged' }), action)).toBe(false);
    }
  );
});

describe('canDeleteBranch', () => {
  const merged = { state: 'merged' as const };

  it("does not offer a fork's branch", () => {
    const fork = pr({ ...merged, headRepo: 'fork/b' });
    expect(mayDeleteBranch(fork, repository)).toBe(false);
    expect(canDeleteBranch(fork, repository, 'head')).toBe(false);
  });

  it('does not offer the default branch', () => {
    const main = pr({ ...merged, headRef: 'main' });
    expect(mayDeleteBranch(main, repository)).toBe(false);
    expect(canDeleteBranch(main, repository, 'head')).toBe(false);
  });

  it('does not offer the branch of an open pull request', () => {
    expect(mayDeleteBranch(pullRequest, repository)).toBe(false);
    expect(canDeleteBranch(pullRequest, repository, 'head')).toBe(false);
  });

  it('offers the branch of a merged pull request from the same repository', () => {
    expect(mayDeleteBranch(pr(merged), repository)).toBe(true);
    expect(canDeleteBranch(pr(merged), repository, 'head')).toBe(true);
  });

  it('does not offer a branch before GitHub told where it points', () => {
    expect(canDeleteBranch(pr(merged), repository, undefined)).toBe(false);
  });

  it('does not offer a branch that is gone', () => {
    expect(canDeleteBranch(pr(merged), repository, null)).toBe(false);
  });

  it('does not offer a branch that got commits since its pull request', () => {
    expect(canDeleteBranch(pr(merged), repository, 'newer')).toBe(false);
  });
});

describe('menuActions', () => {
  // The branch still ends where the pull request does, unless a test says otherwise.
  const menu = (
    subject: PullRequest,
    inRepo: Repository = repository,
    headBranchSha: string | null = subject.headSha
  ) => menuActions(subject, inRepo, primaryControl(subject, inRepo, 'passing'), headBranchSha);

  it('offers auto-merge, draft and close on an open pull request GitHub does not merge yet', () => {
    expect(menu(pr(blocked))).toEqual(['enable-auto-merge', 'draft', 'close']);
  });

  it.each(['clean', 'has_hooks', 'unstable'])(
    'offers no auto-merge on a pull request GitHub can merge now (%s)',
    (mergeableState) => {
      expect(menu(pr({ mergeableState }))).toEqual(['draft', 'close']);
    }
  );

  it('offers merge now and disabling auto-merge once it is armed', () => {
    expect(menu(pr(armed))).toEqual(['merge', 'disable-auto-merge', 'draft', 'close']);
  });

  it('offers the branch of a merged pull request', () => {
    expect(menu(pr({ state: 'merged' }))).toEqual(['delete-branch']);
  });

  it('offers no branch that is gone, as after it was deleted', () => {
    expect(menu(pr({ state: 'merged' }), repository, null)).toEqual([]);
    expect(menu(pr({ state: 'closed' }), repository, null)).toEqual(['reopen']);
  });

  it('offers reopening a closed pull request and its branch', () => {
    expect(menu(pr({ state: 'closed' }))).toEqual(['reopen', 'delete-branch']);
  });

  it('offers ready on a conflicting draft, whose primary control is conflicts', () => {
    expect(menu(pr({ draft: true, mergeableState: 'dirty' }))).toEqual(['ready', 'close']);
  });

  it('offers neither ready nor disabling auto-merge on a closed pull request', () => {
    expect(menu(pr({ state: 'closed', draft: true, ...armed }))).toEqual([
      'reopen',
      'delete-branch',
    ]);
  });

  it('offers nothing in a repository the viewer can only read', () => {
    expect(menu(pullRequest, repo({ canWrite: false }))).toEqual([]);
  });
});
