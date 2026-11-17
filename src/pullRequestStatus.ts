// What a chip, or a thread's details, shows of a pull request: the pull request, its state and the
// mark of its checks, without asking again when the tab regains focus.
import { checksState, type ChecksState } from './detail/detail.logic';
import type { PullRequest, PullRequestCheck, PullRequestRef } from './github';
import { resolvePullRequestState, type PullRequestStatePresentation } from './presentation';
import { NO_FOCUS_REFETCH, useChecks, usePullRequest, type RefetchOptions } from './queries';
import { useGitHubToken } from './token';

/** A pull request, its state and its checks; each undefined until known, or when not asked for. */
export type PullRequestStatus = {
  pr: PullRequest | undefined;
  state: PullRequestStatePresentation | undefined;
  /** Undefined too for a pull request without checks. */
  checks: Exclude<ChecksState, 'none'> | undefined;
  /** Why GitHub refused the pull request, or null. */
  error: Error | null;
  /** The checks themselves while they are asked for; undefined for a closed pull request, or
   * without a token. */
  checkList: { items: PullRequestCheck[] | undefined; failed: boolean } | undefined;
};

/** The status of the pull request `ref`; nothing is asked of GitHub while `ref` is undefined. */
export function usePullRequestStatus(
  ref: PullRequestRef | undefined,
  options: RefetchOptions = NO_FOCUS_REFETCH
): PullRequestStatus {
  const query = usePullRequest(ref, options);
  const pr = query.data;
  const { token } = useGitHubToken();
  // Only an open pull request, draft or not, has checks worth asking for, and only with a token:
  // without one, GitHub allows 60 requests an hour, kept for the pull requests and the panel.
  const withChecks = pr?.state === 'open' && token !== undefined;
  const checks = useChecks(ref, pr?.headSha ?? '', withChecks, options);
  const checksMark = withChecks && checks.data ? checksState(checks.data.items) : 'none';
  return {
    pr,
    state: pr && resolvePullRequestState(pr),
    checks: checksMark === 'none' ? undefined : checksMark,
    error: query.error,
    checkList: withChecks ? { items: checks.data?.items, failed: checks.isError } : undefined,
  };
}
