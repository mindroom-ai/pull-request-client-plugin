import { useQuery } from '@tanstack/react-query';
import {
  fetchBehindBy,
  fetchChecks,
  fetchCommitFiles,
  fetchCommits,
  fetchConversationComments,
  fetchHeadBranch,
  fetchPullRequest,
  fetchPullRequestFiles,
  fetchReviewComments,
  fetchRepository,
  fetchReviews,
  GitHubError,
  GitHubWriteError,
  type PullRequest,
  type PullRequestRef,
} from './github';
import { useGitHubToken, useStoredToken } from './token';

// A refusal GitHub gave twice would be the same again; only a failed request is worth another try.
const retry = (count: number, error: Error) =>
  (error instanceof GitHubError || error instanceof GitHubWriteError) && error.kind !== 'failed'
    ? false
    : count < 2;

// Two minutes keeps a panel's worth of requests inside the anonymous rate limit.
const STALE_TIME = 120_000;

// GitHub's owners and repositories ignore case, so the keys do as well: a link written
// `Acme/Repo` and one written `acme/repo` share what was read, and the refetch after a write
// through one reaches the other. Only the keys: what shows keeps the case it was written in.
const lower = (name: string | undefined) => name?.toLowerCase();

/** What the key of every query of one pull request starts with, to invalidate them together. */
export const pullRequestKey = (ref: PullRequestRef | undefined) =>
  ['pull-requests', 'pr', lower(ref?.owner), lower(ref?.repo), ref?.number] as const;

/** The key of what `useRepository` reads of a pull request's repository. */
export const repositoryKey = (ref: PullRequestRef | undefined) =>
  ['pull-requests', 'repo', lower(ref?.owner), lower(ref?.repo)] as const;

// The token's value never goes in a key (keys show in devtools and error reports); whether there is
// one does, so a result for a public pull request is not reused for the private view of it.
const keyOf = (ref: PullRequestRef | undefined, tokenSet: boolean) =>
  [...pullRequestKey(ref), tokenSet] as const;

/** What a caller can change of a query's refetching: the chips leave out the refetch on window focus,
 * a thread's details also the one on mount, for an answer and for a refusal alike. */
export type RefetchOptions = {
  refetchOnWindowFocus?: boolean;
  refetchOnMount?: boolean;
  retryOnMount?: boolean;
};

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

/**
 * What the viewer may do in the pull request's repository, and how it merges. GraphQL needs a
 * token, so without one nothing is asked. It changes rarely, so a panel opened again within ten
 * minutes reuses it; one opened after the token changed, which makes every answer stale, asks
 * again, as another token is another permission. A refusal is not asked again on mount, until
 * the token changes, which forgets it (`useGitHubToken`).
 */
export function useRepository(ref: PullRequestRef | undefined) {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  return useQuery({
    queryKey: repositoryKey(ref),
    queryFn: ({ signal }) => {
      const { owner, repo } = ref as PullRequestRef;
      const stored = storedToken();
      // Forgotten after the render that enabled the query; no request goes without one.
      if (stored === undefined) throw new GitHubWriteError('badToken', 0);
      return fetchRepository(owner, repo, stored, signal);
    },
    enabled: token !== undefined && ref !== undefined,
    staleTime: 600_000,
    retryOnMount: false,
    retry,
  });
}

/**
 * Where the pull request's branch points on GitHub now, null once it is gone: what tells whether
 * the branch can still be deleted. GraphQL needs a token, so without one nothing is asked. Keyed
 * under the pull request, so the refetch after an action (a deletion among them) asks again.
 */
export function useHeadBranchSha(ref: PullRequestRef, pr: PullRequest, enabled: boolean) {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  return useQuery({
    queryKey: [...keyOf(ref, true), 'head-branch', pr.headRepoId, pr.headRef] as const,
    queryFn: ({ signal }) => {
      const stored = storedToken();
      // Forgotten after the render that enabled the query; no request goes without one.
      if (stored === undefined) throw new GitHubWriteError('badToken', 0);
      return fetchHeadBranch(ref, pr, stored, signal);
    },
    select: (head) => head.sha,
    enabled: enabled && token !== undefined,
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
