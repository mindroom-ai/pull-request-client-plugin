import { describe, expect, it } from 'vitest';

import type { PullRequest, Repository } from '../github';
import { canDeleteBranch, menuActions, primaryControl, resolveMergeMethod } from './actions.logic';

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
  mergeMethods: ['merge', 'squash', 'rebase'],
  autoMergeAllowed: true,
  defaultBranch: 'main',
};

const pr = (extra: Partial<PullRequest>): PullRequest => ({ ...pullRequest, ...extra });
const repo = (extra: Partial<Repository>): Repository => ({ ...repository, ...extra });
const armed = { autoMerge: { method: 'squash' as const } };

describe('primaryControl', () => {
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
    expect(primaryControl(pullRequest, repository, 'pending')).toBe('enable-auto-merge');
  });

  it('offers merge on failing checks when the repository allows no auto-merge', () => {
    expect(primaryControl(pullRequest, repo({ autoMergeAllowed: false }), 'failing')).toBe('merge');
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
  it('takes the chosen method', () => {
    expect(resolveMergeMethod(['merge', 'squash'], 'squash', 'merge')).toBe('squash');
  });

  it('falls to the last method when the chosen one is not allowed', () => {
    expect(resolveMergeMethod(['merge', 'squash'], 'rebase', 'squash')).toBe('squash');
  });

  it("falls to the repository's first method when neither is allowed", () => {
    expect(resolveMergeMethod(['squash', 'rebase'], null, 'merge')).toBe('squash');
  });

  it('is null when the repository allows none', () => {
    expect(resolveMergeMethod([], 'merge', 'merge')).toBeNull();
  });
});

describe('canDeleteBranch', () => {
  const merged = { state: 'merged' as const };

  it("does not offer a fork's branch", () => {
    expect(canDeleteBranch(pr({ ...merged, headRepo: 'fork/b' }), repository)).toBe(false);
  });

  it('does not offer the default branch', () => {
    expect(canDeleteBranch(pr({ ...merged, headRef: 'main' }), repository)).toBe(false);
  });

  it('does not offer the branch of an open pull request', () => {
    expect(canDeleteBranch(pullRequest, repository)).toBe(false);
  });

  it('offers the branch of a merged pull request from the same repository', () => {
    expect(canDeleteBranch(pr(merged), repository)).toBe(true);
  });
});

describe('menuActions', () => {
  const menu = (subject: PullRequest, inRepo: Repository = repository) =>
    menuActions(subject, inRepo, primaryControl(subject, inRepo, 'passing'));

  it('offers auto-merge, draft and close on an open pull request with passing checks', () => {
    expect(menu(pullRequest)).toEqual(['enable-auto-merge', 'draft', 'close']);
  });

  it('offers merge now and disabling auto-merge once it is armed', () => {
    expect(menu(pr(armed))).toEqual(['merge', 'disable-auto-merge', 'draft', 'close']);
  });

  it('offers the branch of a merged pull request', () => {
    expect(menu(pr({ state: 'merged' }))).toEqual(['delete-branch']);
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
