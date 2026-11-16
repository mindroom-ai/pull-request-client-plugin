// Reads which pull requests belong to a thread from the room's state, where the backend
// plugin records them: one state event per thread and pull request, empty once unlinked. Reads
// too the worktree a thread's agent works in, which the `thread-worktree` backend plugin records:
// one state event per thread, empty while it has none.

import { useCallback, useSyncExternalStore } from 'react';
import { RoomStateEvent, type Room } from 'matrix-js-sdk';
import { parsePullRequestUrl, type PullRequestRef } from './github';

export const THREAD_PULL_REQUEST_EVENT_TYPE = 'com.mindroom.thread.pull_request';
export const THREAD_WORKTREE_EVENT_TYPE = 'com.mindroom.thread.worktree';

export type ThreadPullRequestLink = {
  threadId: string;
  pullRequest: PullRequestRef;
  setAt: string;
};

/**
 * A directory relative to the agent's workspace, or the absolute path of one outside it, with its
 * branch and its repository's name: each empty when the worktree's event has none.
 */
export type ThreadWorktree = { path: string; branch: string; repo: string };

/**
 * A room's links by thread, each thread's in the order they were set, and its worktrees by thread;
 * the same object until a link or a worktree changes.
 */
export type RoomPullRequests = {
  byThread: ReadonlyMap<string, readonly PullRequestRef[]>;
  worktrees: ReadonlyMap<string, ThreadWorktree>;
  repositories: number;
};

const NO_PULL_REQUESTS: readonly PullRequestRef[] = [];

const keyOf = (ref: PullRequestRef) => `${ref.owner}/${ref.repo}#${ref.number}`;

/** The link one state event records, or undefined for an unlinked or malformed event. */
export function parseThreadPullRequestLink(
  stateKey: string,
  content: unknown
): ThreadPullRequestLink | undefined {
  let key: unknown;
  try {
    key = JSON.parse(stateKey);
  } catch {
    return undefined;
  }
  if (!Array.isArray(key) || key.length !== 2) return undefined;
  const [threadId, refKey] = key as unknown[];
  if (typeof threadId !== 'string' || typeof refKey !== 'string') return undefined;
  // Only the compact form the backend writes: another form of the same key would show a pull request twice.
  if (JSON.stringify([threadId, refKey]) !== stateKey) return undefined;
  if (typeof content !== 'object' || content === null) return undefined;
  const { url, set_at: setAt } = content as { url?: unknown; set_at?: unknown };
  if (typeof url !== 'string') return undefined;
  let parsed: PullRequestRef | undefined;
  try {
    parsed = parsePullRequestUrl(new URL(url));
  } catch {
    return undefined;
  }
  if (parsed === undefined) return undefined;
  const pullRequest = {
    ...parsed,
    owner: parsed.owner.toLowerCase(),
    repo: parsed.repo.toLowerCase(),
  };
  if (keyOf(pullRequest) !== refKey) return undefined;
  return { threadId, pullRequest, setAt: typeof setAt === 'string' ? setAt : '' };
}

/**
 * The worktree one state event records, whose state key is the thread's root ID, or undefined for
 * a cleared or malformed event.
 */
export function parseThreadWorktree(
  stateKey: string,
  content: unknown
): ({ threadId: string } & ThreadWorktree) | undefined {
  if (typeof content !== 'object' || content === null) return undefined;
  const { path, branch, repo } = content as { path?: unknown; branch?: unknown; repo?: unknown };
  if (typeof path !== 'string' || path === '') return undefined;
  // Only a path in POSIX form that names one directory.
  if (path.includes('\\') || path.split('/').includes('..')) return undefined;
  return {
    threadId: stateKey,
    path,
    branch: typeof branch === 'string' ? branch : '',
    repo: typeof repo === 'string' ? repo : '',
  };
}

/** The room's state events the snapshot is built from: the links', then the worktrees'. */
const eventsOf = (room: Room) => [
  ...room.currentState.getStateEvents(THREAD_PULL_REQUEST_EVENT_TYPE),
  ...room.currentState.getStateEvents(THREAD_WORKTREE_EVENT_TYPE),
];

function readRoom(room: Room): RoomPullRequests {
  const links: ThreadPullRequestLink[] = [];
  for (const event of room.currentState.getStateEvents(THREAD_PULL_REQUEST_EVENT_TYPE)) {
    const link = parseThreadPullRequestLink(event.getStateKey() ?? '', event.getContent());
    if (link !== undefined) links.push(link);
  }
  links.sort((a, b) => (a.setAt < b.setAt ? -1 : a.setAt > b.setAt ? 1 : 0));
  const byThread = new Map<string, PullRequestRef[]>();
  const repositories = new Set<string>();
  for (const { threadId, pullRequest } of links) {
    const list = byThread.get(threadId);
    if (list === undefined) byThread.set(threadId, [pullRequest]);
    else list.push(pullRequest);
    repositories.add(`${pullRequest.owner}/${pullRequest.repo}`);
  }
  const worktrees = new Map<string, ThreadWorktree>();
  for (const event of room.currentState.getStateEvents(THREAD_WORKTREE_EVENT_TYPE)) {
    const worktree = parseThreadWorktree(event.getStateKey() ?? '', event.getContent());
    if (worktree !== undefined) {
      const { path, branch, repo } = worktree;
      worktrees.set(worktree.threadId, { path, branch, repo });
    }
  }
  return { byThread, worktrees, repositories: repositories.size };
}

/**
 * A room's links and worktrees for React: the snapshot last read, the components that read them,
 * and, while any does, the removal of the one listener on the room's state that tells them all of
 * a link or worktree event.
 * The SDK's emitters warn past ten listeners for an event, and a room has a card for each thread.
 */
type RoomStore = {
  snapshot?: { events: readonly unknown[]; pullRequests: RoomPullRequests };
  listeners: Set<() => void>;
  stop?: () => void;
};

const stores = new WeakMap<Room, RoomStore>();

function storeOf(room: Room): RoomStore {
  let store = stores.get(room);
  if (store === undefined) {
    store = { listeners: new Set() };
    stores.set(room, store);
  }
  return store;
}

/** The room's snapshot, rebuilt when its events are no longer the ones it was built from. */
function snapshotOf(room: Room): RoomPullRequests {
  const store = storeOf(room);
  const events = eventsOf(room);
  const cached = store.snapshot;
  if (
    cached !== undefined &&
    cached.events.length === events.length &&
    cached.events.every((event, index) => event === events[index])
  ) {
    return cached.pullRequests;
  }
  const pullRequests = readRoom(room);
  store.snapshot = { events, pullRequests };
  return pullRequests;
}

/** The subscription only tells React to read again; the read checks the room's state itself. */
function subscribeTo(room: Room, notify: () => void): () => void {
  const store = storeOf(room);
  if (store.listeners.size === 0) {
    // A redaction since the first render read the room went unheard; React reads again after this.
    store.snapshot = undefined;
    const state = room.currentState;
    const onEvent = (event: { getType(): string }) => {
      const type = event.getType();
      if (type !== THREAD_PULL_REQUEST_EVENT_TYPE && type !== THREAD_WORKTREE_EVENT_TYPE) return;
      // The SDK redacts a state event in place, so the snapshot's events can be the same objects
      // with other content.
      store.snapshot = undefined;
      store.listeners.forEach((listener) => listener());
    };
    state.on(RoomStateEvent.Events, onEvent);
    store.stop = () => {
      state.off(RoomStateEvent.Events, onEvent);
    };
  }
  store.listeners.add(notify);
  return () => {
    store.listeners.delete(notify);
    if (store.listeners.size > 0) return;
    store.stop?.();
    // Unheard, a redaction would leave the snapshot as it was; the next reader reads the room anew.
    store.snapshot = undefined;
  };
}

/** Every pull request link and worktree of a room, updated when one of their events arrives. */
export function useRoomPullRequests(room: Room): RoomPullRequests {
  const subscribe = useCallback((notify: () => void) => subscribeTo(room, notify), [room]);
  return useSyncExternalStore(subscribe, () => snapshotOf(room));
}

/** A thread's pull requests and worktree, and how many repositories the links of its room span. */
export type ThreadPullRequests = {
  /** In the order they were set; the same empty array when the thread has none. */
  pullRequests: readonly PullRequestRef[];
  repositories: number;
  worktree: ThreadWorktree | undefined;
};

/**
 * The pull requests and the worktree of one thread and the room's count of repositories, from one
 * subscription.
 */
export function useThreadPullRequests(
  room: Room,
  threadId: string | undefined
): ThreadPullRequests {
  const { byThread, worktrees, repositories } = useRoomPullRequests(room);
  if (threadId === undefined) {
    return { pullRequests: NO_PULL_REQUESTS, repositories, worktree: undefined };
  }
  const pullRequests = byThread.get(threadId) ?? NO_PULL_REQUESTS;
  return { pullRequests, repositories, worktree: worktrees.get(threadId) };
}
