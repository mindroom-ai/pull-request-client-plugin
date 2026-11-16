import { useQuery } from '@tanstack/react-query';
import {
  fetchBehindBy,
  fetchChecks,
  fetchCommitFiles,
  fetchCommits,
  fetchConversationComments,
  fetchPullRequest,
  fetchPullRequestFiles,
  fetchReviewComments,
  fetchReviews,
  GitHubError,
  type PullRequestRef,
} from './github';
import { useGitHubToken, useStoredToken } from './token';

// A refusal GitHub gave twice would be the same again; only a failed request is worth another try.
const retry = (count: number, error: Error) =>
  error instanceof GitHubError && error.kind !== 'failed' ? false : count < 2;

// Two minutes keeps a panel's worth of requests inside the anonymous rate limit.
const STALE_TIME = 120_000;

// The token's value never goes in a key (keys show in devtools and error reports); whether there is
// one does, so a result for a public pull request is not reused for the private view of it.
const keyOf = (ref: PullRequestRef | undefined, tokenSet: boolean) =>
  ['pull-requests', 'pr', ref?.owner, ref?.repo, ref?.number, tokenSet] as const;

/** What a caller can change of a query's refetching: the chips leave out the refetch on window focus,
 * a thread's details also the one on mount. */
export type RefetchOptions = { refetchOnWindowFocus?: boolean; refetchOnMount?: boolean };

// A chip asks again when it shows after its answer went stale, not when the tab regains focus:
// every chip seen so far would ask at once, and without a token that spends the hourly limit.
export const NO_FOCUS_REFETCH = { refetchOnWindowFocus: false };

export function usePullRequest(ref: PullRequestRef | undefined, options: RefetchOptions = {}) {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  return useQuery({
    queryKey: keyOf(ref, token !== undefined),
    queryFn: ({ signal }) => fetchPullRequest(ref as PullRequestRef, storedToken(), signal),
    enabled: ref !== undefined,
    staleTime: STALE_TIME,
    retry,
    ...options,
  });
}

export function usePullRequestFiles(ref: PullRequestRef | undefined, enabled: boolean) {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  return useQuery({
    queryKey: [...keyOf(ref, token !== undefined), 'files'] as const,
    queryFn: ({ signal }) => fetchPullRequestFiles(ref as PullRequestRef, storedToken(), signal),
    enabled: enabled && ref !== undefined,
    staleTime: STALE_TIME,
    retry,
  });
}

/** The query of one list or lookup, keyed under the pull request with the token's presence. */
function useRefQuery<T>(
  ref: PullRequestRef | undefined,
  enabled: boolean,
  part: readonly (string | undefined)[],
  load: (ref: PullRequestRef, token: string | undefined, signal: AbortSignal) => Promise<T>,
  options: RefetchOptions = {}
) {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  return useQuery({
    queryKey: [...keyOf(ref, token !== undefined), ...part] as const,
    queryFn: ({ signal }) => load(ref as PullRequestRef, storedToken(), signal),
    enabled: enabled && ref !== undefined,
    staleTime: STALE_TIME,
    retry,
    ...options,
  });
}

export const useChecks = (
  ref: PullRequestRef | undefined,
  headSha: string,
  enabled: boolean,
  options?: RefetchOptions
) =>
  useRefQuery(
    ref,
    enabled && headSha !== '',
    ['checks', headSha],
    (r, token, signal) => fetchChecks(r, headSha, token, signal),
    options
  );

export const useBehindBy = (
  ref: PullRequestRef | undefined,
  baseRef: string,
  headSha: string,
  enabled: boolean
) =>
  useRefQuery(ref, enabled && headSha !== '', ['behind', baseRef, headSha], (r, token, signal) =>
    fetchBehindBy(r, baseRef, headSha, token, signal)
  );

export const useReviews = (ref: PullRequestRef | undefined, enabled: boolean) =>
  useRefQuery(ref, enabled, ['reviews'], fetchReviews);

export const useConversationComments = (ref: PullRequestRef | undefined, enabled: boolean) =>
  useRefQuery(ref, enabled, ['comments'], fetchConversationComments);

export const useReviewComments = (ref: PullRequestRef | undefined, enabled: boolean) =>
  useRefQuery(ref, enabled, ['review-comments'], fetchReviewComments);

export const useCommits = (ref: PullRequestRef | undefined, enabled: boolean) =>
  useRefQuery(ref, enabled, ['commits'], fetchCommits);

export const useCommitFiles = (ref: PullRequestRef | undefined, sha: string, enabled: boolean) =>
  useRefQuery(ref, enabled && sha !== '', ['commit-files', sha], (r, token, signal) =>
    fetchCommitFiles(r, sha, token, signal)
  );
