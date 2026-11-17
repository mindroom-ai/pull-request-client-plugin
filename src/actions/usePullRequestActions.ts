// The header's actions on one pull request: the merge method, one action at a time, and its
// outcome, for the panel to pass to every control that starts one.
import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePluginStorage } from '@mindroom/client-sdk/core';
import {
  GitHubWriteError,
  pullRequestUrl,
  runPullRequestAction,
  type MergeMethod,
  type PullRequest,
  type PullRequestAction,
  type PullRequestRef,
  type Repository,
} from '../github';
import { useRepository } from '../queries';
import { useGitHubToken, useStoredToken } from '../token';
import { resolveMergeMethod } from './actions.logic';

export type ActionResult =
  | { action: PullRequestAction; outcome: 'done' }
  | { action: PullRequestAction; outcome: 'failed'; error: GitHubWriteError };

// The pull requests (by URL) with an action running, across every panel: a second click, or a
// second control, while one runs sends nothing.
const inFlight = new Set<string>();

const METHOD_KEY = 'mergeMethod';
const METHODS: readonly string[] = ['merge', 'squash', 'rebase'];
const asMethod = (value: string | null): MergeMethod | null =>
  value !== null && METHODS.includes(value) ? (value as MergeMethod) : null;

// Only these two merge, so only they need a method.
const MERGES: ReadonlySet<PullRequestAction> = new Set(['merge', 'enable-auto-merge']);

/**
 * The panel's one runner, called before the pull request loads: until `ref` and `pr` are both
 * given, nothing runs and nothing is pending.
 */
export function usePullRequestActions(
  ref: PullRequestRef | undefined,
  pr: PullRequest | undefined
): {
  repo: Repository | undefined;
  method: MergeMethod | null;
  chooseMethod(method: MergeMethod): void;
  pending: PullRequestAction | null;
  result: ActionResult | null;
  perform(action: PullRequestAction): void;
  dismissResult(): void;
} {
  const { token } = useGitHubToken();
  // A repository loaded with a token that is gone since would still offer the writes.
  const repo = useRepository(ref).data;
  const shownRepo = token === undefined ? undefined : repo;
  const storage = usePluginStorage('pull-requests');
  const storedToken = useStoredToken();
  const queryClient = useQueryClient();
  const url = ref ? pullRequestUrl(ref) : undefined;

  const [chosen, setChosen] = useState<{ url: string; method: MergeMethod } | null>(null);
  // What runs, by pull request, so another one shown meanwhile reads as idle and its answer ends
  // only its own.
  const [running, setRunning] = useState<Readonly<Record<string, PullRequestAction>>>({});
  // The outcome belongs to the pull request shown when it came; showing another one drops it.
  const [outcome, setOutcome] = useState<{ url: string | undefined; result: ActionResult | null }>({
    url,
    result: null,
  });
  if (outcome.url !== url) setOutcome({ url, result: null });

  const method = shownRepo
    ? resolveMergeMethod(
        shownRepo.mergeMethods,
        chosen && chosen.url === url ? chosen.method : null,
        asMethod(storage.getItem(METHOD_KEY))
      )
    : null;

  const perform = (action: PullRequestAction) => {
    if (!ref || !pr || url === undefined || inFlight.has(url)) return;
    const stored = storedToken();
    if (stored === undefined) return;
    if (MERGES.has(action) && method === null) return;
    inFlight.add(url);
    setRunning((current) => ({ ...current, [url]: action }));
    setOutcome({ url, result: null });
    const finish = (result: ActionResult, refresh: boolean) => {
      inFlight.delete(url);
      if (refresh) {
        void queryClient.invalidateQueries({
          queryKey: ['pull-requests', 'pr', ref.owner, ref.repo, ref.number],
        });
      }
      setRunning(({ [url]: _done, ...rest }) => rest);
      setOutcome((current) => (current.url === url ? { url, result } : current));
    };
    // Only the merges read the method, and they do not start without one.
    runPullRequestAction(ref, pr, action, method ?? 'merge', stored).then(
      () => finish({ action, outcome: 'done' }, true),
      (caught: unknown) => {
        const error =
          caught instanceof GitHubWriteError ? caught : new GitHubWriteError('failed', 0);
        // A refusal means GitHub's state moved from what was loaded, so load it again.
        finish({ action, outcome: 'failed', error }, error.kind === 'refused');
      }
    );
  };

  return {
    repo: shownRepo,
    method,
    chooseMethod: (next) => {
      if (url === undefined) return;
      setChosen({ url, method: next });
      // The next pull request starts with the method used last.
      storage.setItem(METHOD_KEY, next);
    },
    pending: url !== undefined && pr ? running[url] ?? null : null,
    result: pr && outcome.url === url ? outcome.result : null,
    perform,
    dismissResult: () => setOutcome({ url, result: null }),
  };
}
