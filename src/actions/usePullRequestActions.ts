// The header's actions on one pull request: the merge method, one action at a time, and its
// outcome, for the panel to pass to every control that starts one.
import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePluginStorage } from '@mindroom/client-sdk/core';
import {
  GitHubWriteError,
  runPullRequestAction,
  type ActionOutcome,
  type MergeMethod,
  type PullRequest,
  type PullRequestAction,
  type PullRequestRef,
  type Repository,
} from '../github';
import {
  POST_WRITE_RECHECK_MS,
  markPullRequestMerged,
  pullRequestKey,
  recheckStalePullRequest,
  refreshPullRequest,
  useRepository,
} from '../queries';
import { useGitHubAccess } from '../token';
import { resolveMergeMethod, showsOutcome } from './actions.logic';

// `requested`: GitHub took an update of the branch, but answered before it had made it.
// `unread`: GitHub took the action, but the pull request could not be read again after it, so
// the one on screen is from before.
export type ActionResult =
  | { action: PullRequestAction; outcome: ActionOutcome; unread?: true }
  | { action: PullRequestAction; outcome: 'failed'; error: GitHubWriteError };

// What runs on each pull request and what came of its last action, across every panel and
// every mount of one: a second click, or a second control, while one runs sends nothing, and a
// panel opened again on a pull request mid-action shows it running. By `actionKey`.
type Entry = { pending: PullRequestAction | null; result: ActionResult | null };
const IDLE: Entry = { pending: null, result: null };
const REVERSIBLE_STATE_ACTIONS: ReadonlySet<PullRequestAction> = new Set([
  'close',
  'reopen',
  'ready',
  'draft',
  'enable-auto-merge',
  'disable-auto-merge',
]);
const staleRechecks = new Map<string, ReturnType<typeof setTimeout>>();

const cancelStaleRecheck = (key: string) => {
  clearTimeout(staleRechecks.get(key));
  staleRechecks.delete(key);
};

const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();

const entryOf = (key: string): Entry => entries.get(key) ?? IDLE;
function setEntry(key: string, entry: Entry) {
  if (entry.pending === null && entry.result === null) entries.delete(key);
  else entries.set(key, entry);
  listeners.forEach((listener) => listener());
}
function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Forgets every action and outcome. Only the tests call it: this state is the module's, not a
 * component's, so that it outlives a panel, which also makes it outlive a test. An outcome
 * stays until it is dismissed, and the tests act on one pull request, so without this a test
 * would start with the outcome of the one before it.
 */
export function resetPullRequestActions() {
  staleRechecks.forEach((timer) => clearTimeout(timer));
  staleRechecks.clear();
  entries.clear();
  listeners.forEach((listener) => listener());
}

// GitHub's owners and repositories ignore case, so `Acme/Repo#7` and `acme/repo#7` are one pull
// request, with one lock, as they have one set of queries.
const actionKey = (ref: PullRequestRef) =>
  `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

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
  const access = useGitHubAccess();
  // A repository loaded with a token, or a connection, that is gone since would still offer the
  // writes.
  const repo = useRepository(ref).data;
  const shownRepo = access.via === undefined ? undefined : repo;
  const storage = usePluginStorage('pull-requests');
  const queryClient = useQueryClient();
  const key = ref ? actionKey(ref) : undefined;
  // Another pull request's entry is never read here, so its action and outcome never show.
  const entry = useSyncExternalStore(subscribe, () => (key === undefined ? IDLE : entryOf(key)));

  const [chosen, setChosen] = useState<{ key: string; method: MergeMethod } | null>(null);
  // A pull request with auto-merge armed starts on the armed method, as in T3 Code, so that
  // Merge now merges the way its badge says. Taken once for each method it is armed with: a
  // method chosen after that holds, and the armed one is not kept as the viewer's own choice.
  const armedMethod = pr?.autoMerge?.method;
  const armedKey = `${key}:${armedMethod ?? ''}`;
  const [seenArmedKey, setSeenArmedKey] = useState<string | null>(null);
  if (seenArmedKey !== armedKey) {
    setSeenArmedKey(armedKey);
    if (key !== undefined && armedMethod !== undefined) setChosen({ key, method: armedMethod });
  }

  const method = shownRepo
    ? resolveMergeMethod(
        shownRepo.mergeMethods,
        chosen && chosen.key === key ? chosen.method : null,
        asMethod(storage.getItem(METHOD_KEY))
      )
    : null;

  const perform = (action: PullRequestAction) => {
    // The store, not what this render read: a second click in the same event finds it locked.
    if (!ref || !pr || key === undefined || entryOf(key).pending !== null) return;
    // The access now, and its key, under which the pull request is read again after the write.
    const { key: used, auth } = access.current();
    if (auth === undefined) return;
    if (MERGES.has(action) && method === null) return;
    cancelStaleRecheck(key);
    setEntry(key, { pending: action, result: null });
    const finish = async (result: ActionResult) => {
      let read = false;
      try {
        // Whatever came, GitHub may hold another state than the one loaded: a refusal says it
        // moved, and a failed answer may come after GitHub took the write. The action runs on
        // until that state is read: unlocked before, the controls would offer the pull request
        // as it was (a second merge of a merged one, which GitHub then refuses).
        read = await refreshPullRequest(queryClient, ref, used);
      } finally {
        // Record a confirmed merge right as the action unlocks so a stale open GET cannot regress
        // it, while keeping the focused button mounted until busy flips false and focus hands off.
        if (result.outcome === 'done' && result.action === 'merge') {
          markPullRequestMerged(queryClient, ref, used);
        }
        // The outcome stays with its own pull request, to show when that one is shown again.
        const outcome =
          !read && result.outcome !== 'failed' ? { ...result, unread: true as const } : result;
        setEntry(key, { pending: null, result: outcome });
        if (read && result.outcome === 'done' && REVERSIBLE_STATE_ACTIONS.has(result.action)) {
          const data = queryClient.getQueryCache().find<PullRequest>({
            queryKey: [...pullRequestKey(ref), used],
            exact: true,
            type: 'active',
          })?.state.data;
          if (data !== undefined && !showsOutcome(data, result.action)) {
            cancelStaleRecheck(key);
            staleRechecks.set(
              key,
              setTimeout(() => {
                staleRechecks.delete(key);
                void recheckStalePullRequest(queryClient, ref, used);
              }, POST_WRITE_RECHECK_MS)
            );
          }
        }
      }
    };
    // Only the merges read the method, and they do not start without one.
    void runPullRequestAction(ref, pr, action, method ?? 'merge', auth).then(
      (outcome) => finish({ action, outcome }),
      (caught: unknown) => {
        const error =
          caught instanceof GitHubWriteError ? caught : new GitHubWriteError('failed', 0);
        return finish({ action, outcome: 'failed', error });
      }
    );
  };

  return {
    repo: shownRepo,
    method,
    chooseMethod: (next) => {
      if (key === undefined) return;
      setChosen({ key, method: next });
      // The next pull request starts with the method used last.
      storage.setItem(METHOD_KEY, next);
    },
    pending: pr ? entry.pending : null,
    result: pr ? entry.result : null,
    perform,
    dismissResult: () => {
      if (key === undefined) return;
      const current = entryOf(key);
      if (current.result !== null) setEntry(key, { ...current, result: null });
    },
  };
}
