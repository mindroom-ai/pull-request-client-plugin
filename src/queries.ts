import { useQuery } from '@tanstack/react-query';
import {
  fetchPullRequest,
  fetchPullRequestFiles,
  GitHubError,
  type PullRequestRef,
} from './github';
import { useGitHubToken, useStoredToken } from './token';

// A refusal GitHub gave twice would be the same again; only a failed request is worth another try.
const retry = (count: number, error: Error) =>
  error instanceof GitHubError && error.kind !== 'failed' ? false : count < 2;

// The token's value never goes in a key (keys show in devtools and error reports); whether there is
// one does, so a result for a public pull request is not reused for the private view of it.
const keyOf = (ref: PullRequestRef | undefined, tokenSet: boolean) =>
  ['pull-requests', 'pr', ref?.owner, ref?.repo, ref?.number, tokenSet] as const;

export function usePullRequest(ref: PullRequestRef | undefined) {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  return useQuery({
    queryKey: keyOf(ref, token !== undefined),
    queryFn: ({ signal }) => fetchPullRequest(ref as PullRequestRef, storedToken(), signal),
    enabled: ref !== undefined,
    staleTime: 60_000,
    retry,
  });
}

export function usePullRequestFiles(ref: PullRequestRef | undefined, enabled: boolean) {
  const { token } = useGitHubToken();
  const storedToken = useStoredToken();
  return useQuery({
    queryKey: [...keyOf(ref, token !== undefined), 'files'] as const,
    queryFn: ({ signal }) => fetchPullRequestFiles(ref as PullRequestRef, storedToken(), signal),
    enabled: enabled && ref !== undefined,
    staleTime: 60_000,
    retry,
  });
}
