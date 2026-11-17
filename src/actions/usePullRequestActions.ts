// The header's actions on one pull request: the merge method, one action at a time, and its
// outcome, for the panel to pass to every control that starts one.
import { useState, useSyncExternalStore } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { usePluginStorage } from '@mindroom/client-sdk/core';
import {
  fetchPullRequest,
  GitHubWriteError,
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

// `requested`: GitHub took an update of the branch, but did not show its new head in time.
export type ActionResult =
  | { action: PullRequestAction; outcome: 'done' | 'requested' }
  | { action: PullRequestAction; outcome: 'failed'; error: GitHubWriteError };

// What runs on each pull request and what came of its last action, across every panel and
// every mount of one: a second click, or a second control, while one runs sends nothing, and a
// panel opened again on a pull request mid-action shows it running. By `actionKey`.
type Entry = { pending: PullRequestAction | null; result: ActionResult | null };
const IDLE: Entry = { pending: null, result: null };
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

/** Forgets every action and outcome, so that each test starts from none. */
export function resetPullRequestActions() {
  entries.clear();
  listeners.forEach((listener) => listener());
}

// GitHub's owners and repositories ignore case, so `Acme/Repo#7` and `acme/repo#7` are one pull
// request, with one lock.
const actionKey = (ref: PullRequestRef) =>
  `${ref.owner.toLowerCase()}/${ref.repo.toLowerCase()}#${ref.number}`;

const METHOD_KEY = 'mergeMethod';
const METHODS: readonly string[] = ['merge', 'squash', 'rebase'];
const asMethod = (value: string | null): MergeMethod | null =>
  value !== null && METHODS.includes(value) ? (value as MergeMethod) : null;

// Only these two merge, so only they need a method.
const MERGES: ReadonlySet<PullRequestAction> = new Set(['merge', 'enable-auto-merge']);

// GitHub answers an update of the branch before it has made the branch's new commit.
const UPDATES: ReadonlySet<PullRequestAction> = new Set(['update-branch', 'update-branch-rebase']);
const HEAD_POLL_MS = 2_000;
const HEAD_WAIT_MS = 30_000;

/**
 * Whether GitHub shows the pull request on another head than the loaded one within half a
 * minute: asked at once, then every two seconds. Until it does, the panel's own read would
 * still get the old head, show the branch as behind, and send that head with a merge, which
 * GitHub refuses.
 */
async function headMoved(ref: PullRequestRef, pr: PullRequest, token: string): Promise<boolean> {
  for (let waited = 0; ; waited += HEAD_POLL_MS) {
    // A read that fails tells nothing; the next one may.
    const head = await fetchPullRequest(ref, token).then(
      (now) => now.headSha,
      () => pr.headSha
    );
    if (head !== pr.headSha) return true;
    if (waited >= HEAD_WAIT_MS) return false;
    await new Promise((resolve) => setTimeout(resolve, HEAD_POLL_MS));
  }
}

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
    const stored = storedToken();
    if (stored === undefined) return;
    if (MERGES.has(action) && method === null) return;
    setEntry(key, { pending: action, result: null });
    const finish = async (result: ActionResult) => {
      try {
        // Whatever came, GitHub may hold another state than the one loaded: a refusal says it
        // moved, and a failed answer may come after GitHub took the write. The action runs on
        // until that state is read: unlocked before, the controls would offer the pull request
        // as it was (a second merge of a merged one, which GitHub then refuses).
        await queryClient.invalidateQueries({
          queryKey: ['pull-requests', 'pr', ref.owner, ref.repo, ref.number],
        });
      } finally {
        // The outcome stays with its own pull request, to show when that one is shown again.
        setEntry(key, { pending: null, result });
      }
    };
    // Only the merges read the method, and they do not start without one.
    void runPullRequestAction(ref, pr, action, method ?? 'merge', stored).then(
      async () => {
        const moved = !UPDATES.has(action) || (await headMoved(ref, pr, stored));
        return finish({ action, outcome: moved ? 'done' : 'requested' });
      },
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
