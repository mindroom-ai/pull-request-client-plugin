// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDetail.logic.ts at 428d3659), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// What the header offers on a pull request: its one primary control, the merge method, and the
// actions its menu lists.
import type { MergeMethod, PullRequest, PullRequestAction, Repository } from '../github';
import type { ChecksState } from '../detail/detail.logic';

export type PrimaryControl =
  | 'merged'
  | 'closed'
  | 'conflicts'
  | 'ready'
  | 'auto-merge-armed'
  | 'enable-auto-merge'
  | 'merge'
  | null;

// The states in which GitHub merges at once. It refuses to arm auto-merge in them, so there
// the pull request merges and auto-merge is not offered (T3 Code's IMMEDIATELY_MERGEABLE).
const MERGES_NOW: ReadonlySet<string | null> = new Set(['clean', 'has_hooks', 'unstable']);

/** Whether auto-merge can be armed: the repository allows it, and GitHub would not merge now. */
function canArmAutoMerge(pr: PullRequest, repo: Repository): boolean {
  return repo.autoMergeAllowed && !MERGES_NOW.has(pr.mergeableState);
}

/** The header's one control; checks not loaded yet, or none at all, count as passing. */
export function primaryControl(
  pr: PullRequest,
  repo: Repository,
  checks: ChecksState | undefined
): PrimaryControl {
  if (pr.state === 'merged') return 'merged';
  if (pr.state === 'closed') return 'closed';
  if (pr.mergeableState === 'dirty') return 'conflicts';
  if (pr.draft) return repo.canWrite ? 'ready' : null;
  if (pr.autoMerge) return 'auto-merge-armed';
  if (repo.mergeMethods.length === 0) return null;
  if ((checks === 'pending' || checks === 'failing') && canArmAutoMerge(pr, repo)) {
    return 'enable-auto-merge';
  }
  return repo.canWrite ? 'merge' : null;
}

/** The viewer's choice, else the method they used last, else the repository's first. */
export function resolveMergeMethod(
  allowed: MergeMethod[],
  chosen: MergeMethod | null,
  last: MergeMethod | null
): MergeMethod | null {
  for (const method of [chosen, last]) {
    if (method && allowed.includes(method)) return method;
  }
  return allowed[0] ?? null;
}

/** Only a branch of this repository, once its pull request is done, and not the default one. */
export function canDeleteBranch(pr: PullRequest, repo: Repository): boolean {
  return (
    pr.state !== 'open' &&
    repo.canWrite &&
    pr.headRepo === pr.baseRepo &&
    pr.headRef !== '' &&
    pr.headRef !== repo.defaultBranch
  );
}

/** The menu's actions, in its order; what the primary control already offers is left out. */
export function menuActions(
  pr: PullRequest,
  repo: Repository,
  primary: PrimaryControl
): PullRequestAction[] {
  if (!repo.canWrite) return [];
  const open = pr.state === 'open';
  const armed = pr.autoMerge !== null;
  const actions: PullRequestAction[] = [];
  if ((primary === 'enable-auto-merge' || primary === 'auto-merge-armed') && !pr.draft) {
    actions.push('merge');
  }
  if (open && !armed && primary === 'merge' && canArmAutoMerge(pr, repo)) {
    actions.push('enable-auto-merge');
  }
  // GitHub may keep the auto-merge it merged with on a merged pull request, so only an open one.
  if (open && armed) actions.push('disable-auto-merge');
  // A draft whose primary is not Ready, a conflicting one, still gets it here; a closed one does not.
  if (open && pr.draft && primary !== 'ready') actions.push('ready');
  if (open && !pr.draft) actions.push('draft');
  if (open) actions.push('close');
  if (pr.state === 'closed') actions.push('reopen');
  if (canDeleteBranch(pr, repo)) actions.push('delete-branch');
  return actions;
}
