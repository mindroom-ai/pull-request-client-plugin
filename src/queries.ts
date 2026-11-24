import { useEffect, useState } from 'react';
import {
  isCancelledError,
  useQueries,
  useQuery,
  useQueryClient,
  type InvalidateQueryFilters,
  type Query,
  type QueryCache,
  type QueryClient,
  type QueryFunctionContext,
} from '@tanstack/react-query';
import {
  fetchBehindBy,
  fetchChecks,
  fetchCommitFiles,
  fetchDiffBlob,
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
  refused,
  type GitHubAuth,
  type PullRequest,
  type PullRequestRef,
} from './github';
import { useGitHubAccess, type AccessKey, type GitHubAccess } from './token';

// A refusal GitHub gave twice would be the same again; only a failed request is worth another try.
// A read cancelled because its key no longer names the access (`authFor`) is not tried again.
const retry = (count: number, error: Error) =>
  isCancelledError(error) ||
  ((error instanceof GitHubError || error instanceof GitHubWriteError) && error.kind !== 'failed')
    ? false
    : count < 2;

// Two minutes keeps a panel's worth of requests inside the anonymous rate limit.
export const STALE_TIME = 120_000;

// GitHub's owners and repositories ignore case, so the keys do as well: a link written
// `Acme/Repo` and one written `acme/repo` share what was read, and the refetch after a write
// through one reaches the other. Only the keys: what shows keeps the case it was written in.
const lower = (name: string | undefined) => name?.toLowerCase();

/** What the key of every query of one pull request starts with, to invalidate them together. */
export const pullRequestKey = (ref: PullRequestRef | undefined) =>
  ['pull-requests', 'pr', lower(ref?.owner), lower(ref?.repo), ref?.number] as const;

/** What the keys of what `useRepository` reads of a pull request's repository start with. */
export const repositoryKey = (ref: PullRequestRef | undefined) =>
  ['pull-requests', 'repo', lower(ref?.owner), lower(ref?.repo)] as const;

// The token's value never goes in a key (keys show in devtools and error reports); how GitHub is
// reached does (`GitHubAccess.key`), so a result for a public pull request is not reused for the
// private view of it, nor one read through MindRoom for one read with a token.
const keyOf = (ref: PullRequestRef | undefined, access: AccessKey) =>
  [...pullRequestKey(ref), access] as const;

// A write can finish waiting for its summary while its other refetches are still running.
const writeRefreshes = new WeakMap<Query, number>();

function invalidateAfterWrite(client: QueryClient, filters: InvalidateQueryFilters) {
  const active = client.getQueryCache().findAll({ ...filters, type: 'active' });
  for (const query of active) writeRefreshes.set(query, (writeRefreshes.get(query) ?? 0) + 1);
  const refreshed = client.invalidateQueries(filters);
  for (const query of active) {
    // A cached read can be replaced on invalidation; a cold read is joined instead.
    waitingProxyReads.get(query)?.(false);
    const release = () => {
      const count = writeRefreshes.get(query) ?? 0;
      if (count <= 1) writeRefreshes.delete(query);
      else writeRefreshes.set(query, count - 1);
    };
    // Invalidation itself does not await offline reads; keep priority until each fetch settles.
    const fetching = query.promise;
    if (fetching) void fetching.then(release, release);
    else release();
  }
  return refreshed;
}

/**
 * After a write: everything read of the pull request is stale and asked again, and the promise
 * settles once the pull request itself is read again. Its other parts (the files, the checks,
 * the comments) are not waited for: a large pull request's files take long, and nothing that
 * depends on the write reads them. Resolves to whether that read worked: false leaves on screen
 * the pull request from before the write. True also when nothing on screen reads it. `access`,
 * the key of the access the write went with, is the read that counts: what another room shows
 * of the pull request with another access (anonymously, as not found) is asked again too, each
 * with the access its own key names (`authFor`), but says nothing of this write.
 */
export async function refreshPullRequest(
  queryClient: QueryClient,
  ref: PullRequestRef,
  access: AccessKey
): Promise<boolean> {
  const queryKey = pullRequestKey(ref);
  const used = [...queryKey, access];
  // The pull request's own query has only how GitHub is reached after the start they all share.
  const own = (query: Query) => query.queryKey.length === used.length;
  const read = (query: Query) => own(query) && query.queryKey[queryKey.length] === access;
  // Each query once: asked again by both, the first request would be dropped for the second.
  void invalidateAfterWrite(queryClient, { queryKey, predicate: (query) => !read(query) });
  await invalidateAfterWrite(queryClient, { queryKey, predicate: read });
  // Only what is on screen was asked again; a failure of an earlier read, as the one without a
  // token of a private pull request, is not this read's.
  const shown = queryClient.getQueryCache().findAll({ queryKey, predicate: read, type: 'active' });
  return shown.every((query) => query.state.status !== 'error');
}

type QueryState = { state: { data: unknown; error: unknown } };

// What a pull request's query read before GitHub refused it, until a read works again: no answer,
// also beside a later read that failed.
const refusedData = new WeakSet<object>();

/** Whether the query's answer is GitHub's refusal, or what it read before one. */
export const isRefused = (query: { data: unknown; error: unknown }) =>
  refused(query.error) || refusedData.has(query.data as object);

/** For a refetch option: false after a refusal, so none asks again by itself (a new token does). */
export const unlessRefused = (query: QueryState) => !isRefused(query.state);

/** A query's answer: also the last one beside a read again that failed, none after a refusal. */
export const answerOf = <T>(query: { data: T | undefined; error: unknown }) =>
  isRefused(query) ? undefined : query.data;

// Mark overview observers without changing the query key shared with foreground surfaces.
export const BACKGROUND_READ = { meta: { mindroomPullRequestsBackground: true } } as const;

/** What a caller can change of a query's refetching: the chips leave out the refetch on window focus,
 * a thread's details also the one on mount, for an answer and for a refusal alike, and the banner's
 * button with access adds an interval (`useBannerRefetch`); `enabled: false` reads only what is
 * already there. */
export type RefetchOptions = {
  meta?: typeof BACKGROUND_READ.meta;
  enabled?: false | ((query: QueryState) => boolean);
  gcTime?: number;
  refetchOnWindowFocus?: boolean | ((query: QueryState) => boolean);
  refetchOnMount?: boolean | ((query: QueryState) => boolean);
  refetchOnReconnect?: boolean | ((query: QueryState) => boolean);
  retryOnMount?: boolean | ((query: QueryState) => boolean);
  /** A pull request's query only: how often to read it again, per its answer (`query`). */
  refetchInterval?: (query: QueryState) => number | false;
  refetchIntervalInBackground?: boolean;
};

// A chip asks again when it shows after its answer went stale, not when the tab regains focus:
// every chip seen so far would ask at once, and without a token that spends the hourly limit.
export const NO_FOCUS_REFETCH = { refetchOnWindowFocus: false };

// Share four slots across background proxied summaries and checks (one or up to two POSTs).
const MAX_PROXY_READ_JOBS = 4;
let proxyReadJobs = 0;
const waitingProxyReads = new Map<Query, (occupiesSlot: boolean) => void>();
const watchedProxyCaches = new WeakSet<QueryCache>();

function observerPriority(query: Query) {
  let background = false;
  for (const observer of query.observers) {
    const { enabled, meta } = observer.options;
    if ((typeof enabled === 'function' ? enabled(query) : enabled) === false) continue;
    if (meta?.mindroomPullRequestsBackground !== true) return 'foreground';
    background = true;
  }
  return background ? 'background' : undefined;
}

function watchProxyReads(cache: QueryCache) {
  if (watchedProxyCaches.has(cache)) return;
  watchedProxyCaches.add(cache);
  cache.subscribe(({ type, query }) => {
    if (
      type !== 'observerAdded' &&
      type !== 'observerRemoved' &&
      type !== 'observerOptionsUpdated'
    ) {
      return;
    }
    const start = waitingProxyReads.get(query);
    if (!start) return;
    const priority = observerPriority(query);
    if (priority === 'foreground') start(false);
    else if (priority === undefined) void query.cancel({ revert: true });
  });
}

const enabledOf = (base: boolean, extra: RefetchOptions['enabled']) =>
  !base || extra === false ? false : extra ?? true;

async function withProxyRead<T>(
  { client, queryKey, signal, meta }: QueryFunctionContext,
  load: () => Promise<T>
): Promise<T> {
  signal.throwIfAborted();
  const cache = client.getQueryCache();
  const query = cache.get(client.defaultQueryOptions({ queryKey }).queryHash);
  if (!query || writeRefreshes.has(query)) return load();
  // Check on every fetch attempt, regardless of which observer's options initiated it.
  const priority = observerPriority(query);
  const background =
    priority === 'background' ||
    (priority === undefined && meta?.mindroomPullRequestsBackground === true);
  if (!background) return load();

  let occupiesSlot = true;
  if (proxyReadJobs < MAX_PROXY_READ_JOBS) proxyReadJobs += 1;
  else {
    watchProxyReads(cache);
    occupiesSlot = await new Promise<boolean>((resolve, reject) => {
      const start = (slot: boolean) => {
        waitingProxyReads.delete(query);
        signal.removeEventListener('abort', abort);
        resolve(slot);
      };
      const abort = () => {
        waitingProxyReads.delete(query);
        reject(signal.reason);
      };
      waitingProxyReads.set(query, start);
      signal.addEventListener('abort', abort, { once: true });
    });
  }
  try {
    // A queued read can be aborted after release but before resuming.
    signal.throwIfAborted();
    return await load();
  } finally {
    if (occupiesSlot) {
      const next = waitingProxyReads.values().next().value;
      if (next) next(true);
      else proxyReadJobs -= 1;
    }
  }
}

// The query of one pull request, the same for `usePullRequest` and `usePullRequests`.
const pullRequestQuery = (
  ref: PullRequestRef | undefined,
  access: GitHubAccess,
  options: RefetchOptions
) => ({
  queryKey: keyOf(ref, access.key),
  queryFn: (context: QueryFunctionContext) => {
    const { client, queryKey, signal } = context;
    const read = () => {
      const before = client.getQueryData<PullRequest>(queryKey);
      return fetchPullRequest(ref as PullRequestRef, access.authFor(access.key), signal).then(
        (pr) => (before && refusedData.delete(before), pr),
        (error: unknown) => {
          if (before && refused(error)) refusedData.add(before);
          throw error;
        }
      );
    };
    return access.via === 'server' ? withProxyRead(context, read) : read();
  },
  staleTime: STALE_TIME,
  retry,
  ...options,
  enabled: enabledOf(ref !== undefined && !access.pending, options.enabled),
});

export function usePullRequest(ref: PullRequestRef | undefined, options: RefetchOptions = {}) {
  return useQuery(pullRequestQuery(ref, useGitHubAccess(), options));
}

// GitHub computes whether a pull request merges after its base moved, in about a second; until
// then its `mergeable` is null. It is read again after each of these, while it still is.
const MERGEABLE_RECHECKS = [1_000, 2_000, 4_000];

/**
 * While GitHub still computes whether the open pull request `pr` merges (`mergeable` null), reads
 * it again a few times, later each time, under the key it shows now and while it shows (`enabled`
 * and mounted); true meanwhile, so that what depends on it waits. Once the reads are spent, what
 * depends on it goes by GitHub's answer then. Another key, an answer, or the pull request changed
 * on GitHub (its `updatedAt` or head) starts the count afresh.
 * None starts while `paused` (an action runs): the read after it is the action's own.
 */
export function useMergeableRecheck(
  ref: PullRequestRef | undefined,
  pr: PullRequest | undefined,
  enabled: boolean,
  paused: boolean
): boolean {
  const queryClient = useQueryClient();
  const { key } = useGitHubAccess();
  const scope = JSON.stringify([keyOf(ref, key), pr?.updatedAt, pr?.headSha]);
  const unknown = enabled && ref !== undefined && pr?.state === 'open' && pr.mergeable === null;
  const [reads, setReads] = useState({ scope, count: 0 });
  if (reads.scope !== scope || (!unknown && reads.count !== 0)) setReads({ scope, count: 0 });
  const count = unknown && reads.scope === scope ? reads.count : 0;
  useEffect(() => {
    if (!unknown || paused || count >= MERGEABLE_RECHECKS.length) return undefined;
    // A read that ends after the key changed, or the panel went, counts for none.
    let live = true;
    const timer = setTimeout(() => {
      void queryClient
        // Joining a read under way, which may be an action's, rather than replacing it.
        .refetchQueries(
          { queryKey: keyOf(ref, key), exact: true, type: 'active' },
          { cancelRefetch: false }
        )
        .finally(() => live && setReads({ scope, count: count + 1 }));
    }, MERGEABLE_RECHECKS[count]);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [count, key, paused, queryClient, ref, scope, unknown]);
  return unknown && count < MERGEABLE_RECHECKS.length;
}

/** The pull requests `refs` as `usePullRequest` reads each, through the same queries. */
export function usePullRequests(refs: readonly PullRequestRef[], options: RefetchOptions = {}) {
  const access = useGitHubAccess();
  return useQueries({ queries: refs.map((ref) => pullRequestQuery(ref, access, options)) });
}

// Evict closed PR and commit file lists after a minute instead of retaining large patches for 5m.
const FILES_GC_TIME = 60_000;

export function usePullRequestFiles(ref: PullRequestRef | undefined, enabled: boolean) {
  const access = useGitHubAccess();
  return useQuery({
    queryKey: [...keyOf(ref, access.key), 'files'] as const,
    queryFn: ({ signal }) =>
      fetchPullRequestFiles(ref as PullRequestRef, access.authFor(access.key), signal),
    enabled: enabled && ref !== undefined && !access.pending,
    staleTime: STALE_TIME,
    gcTime: FILES_GC_TIME,
    retry,
  });
}

/**
 * What the viewer may do in the pull request's repository, and how it merges. GraphQL needs a
 * token or MindRoom's connection, so without either nothing is asked. It changes rarely, so a
 * panel opened again within ten minutes reuses it; one opened after the token or the connection
 * changed, which makes every answer stale, asks again, as another account is another permission.
 * A refusal is not asked again on mount, until the token or the connection changes, which
 * forgets it (`useGitHubToken`, `useGitHubAccess`).
 */
export function useRepository(ref: PullRequestRef | undefined) {
  const access = useGitHubAccess();
  return useQuery({
    // Under how GitHub is reached, as each account may do other things there.
    queryKey: [...repositoryKey(ref), access.key] as const,
    queryFn: ({ signal }) => {
      const { owner, repo } = ref as PullRequestRef;
      const auth = access.authFor(access.key);
      // Forgotten after the render that enabled the query; no request goes without one.
      if (auth === undefined) throw new GitHubWriteError('badToken', 0);
      return fetchRepository(owner, repo, auth, signal);
    },
    enabled: access.via !== undefined && ref !== undefined,
    staleTime: 600_000,
    retryOnMount: false,
    retry,
  });
}

/**
 * Where the pull request's branch points on GitHub now, null once it is gone: what tells whether
 * the branch can still be deleted. GraphQL needs a token or MindRoom's connection, so without
 * either nothing is asked. Keyed under the pull request, so the refetch after an action (a
 * deletion among them) asks again.
 */
export function useHeadBranchSha(ref: PullRequestRef, pr: PullRequest, enabled: boolean) {
  const access = useGitHubAccess();
  return useQuery({
    queryKey: [...keyOf(ref, access.key), 'head-branch', pr.headRepoId, pr.headRef] as const,
    queryFn: ({ signal }) => {
      const auth = access.authFor(access.key);
      // Forgotten after the render that enabled the query; no request goes without one.
      if (auth === undefined) throw new GitHubWriteError('badToken', 0);
      return fetchHeadBranch(ref, pr, auth, signal);
    },
    select: (head) => head.sha,
    enabled: enabled && access.via !== undefined,
    staleTime: STALE_TIME,
    retry,
  });
}

/** The query of one list or lookup, keyed under the pull request with how GitHub is reached. */
function useRefQuery<T>(
  ref: PullRequestRef | undefined,
  enabled: boolean,
  part: readonly (string | undefined)[],
  load: (ref: PullRequestRef, token: GitHubAuth | undefined, signal: AbortSignal) => Promise<T>,
  options: RefetchOptions = {},
  limitProxyReads = false
) {
  const access = useGitHubAccess();
  return useQuery({
    queryKey: [...keyOf(ref, access.key), ...part] as const,
    queryFn: (context) => {
      const { signal } = context;
      const read = () => load(ref as PullRequestRef, access.authFor(access.key), signal);
      return limitProxyReads && access.via === 'server' ? withProxyRead(context, read) : read();
    },
    staleTime: STALE_TIME,
    retry,
    ...options,
    enabled: enabledOf(enabled && ref !== undefined && !access.pending, options.enabled),
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
    options,
    true // Limit background proxied reads.
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
  useRefQuery(
    ref,
    enabled && sha !== '',
    ['commit-files', sha],
    (r, token, signal) => fetchCommitFiles(r, sha, token, signal),
    { gcTime: FILES_GC_TIME }
  );

// Bound concurrent blob reads across panels.
const MAX_BLOB_READS = 4;
let blobReads = 0;
const waitingBlobReads = new Set<() => void>();

async function withBlobRead(
  signal: AbortSignal | undefined,
  load: () => Promise<string | null>
): Promise<string | null> {
  signal?.throwIfAborted();
  if (blobReads < MAX_BLOB_READS) blobReads += 1;
  else {
    await new Promise<void>((resolve, reject) => {
      const start = () => {
        waitingBlobReads.delete(start);
        signal?.removeEventListener('abort', abort);
        resolve();
      };
      const abort = () => {
        waitingBlobReads.delete(start);
        reject(signal?.reason);
      };
      waitingBlobReads.add(start);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }
  try {
    signal?.throwIfAborted();
    return await load();
  } finally {
    const next = waitingBlobReads.values().next().value;
    if (next) next();
    else blobReads -= 1;
  }
}

/** Loads one diff blob on demand without retaining it in React Query. */
export function loadDiffBlob(
  ref: PullRequestRef,
  sha: string,
  access: Pick<GitHubAccess, 'key' | 'authFor'>,
  signal?: AbortSignal
): Promise<string | null> {
  const accessKey = access.key;
  return withBlobRead(signal, async () => {
    const auth = access.authFor(accessKey);
    if (auth === undefined) throw new GitHubError('badToken', 0);
    return fetchDiffBlob(ref, sha, auth, signal);
  });
}
