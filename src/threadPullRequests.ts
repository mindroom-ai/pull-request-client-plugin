// Reads which pull requests belong to a thread from the room's state, where the backend
// plugin records them: one state event per thread and pull request, empty once unlinked.

import { useCallback, useSyncExternalStore } from 'react';
import { RoomStateEvent, type Room } from 'matrix-js-sdk';
import { parsePullRequestUrl, type PullRequestRef } from './github';

export const THREAD_PULL_REQUEST_EVENT_TYPE = 'com.mindroom.thread.pull_request';

export type ThreadPullRequestLink = {
  threadId: string;
  pullRequest: PullRequestRef;
  setAt: string;
};

/** A room's links by thread, each thread's in the order they were set; the same object until a link changes. */
export type RoomPullRequests = {
  byThread: ReadonlyMap<string, readonly PullRequestRef[]>;
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
  return { byThread, repositories: repositories.size };
}

/**
 * A room's links for React: the snapshot last read, the components that read them, and, while any
 * does, the removal of the one listener on the room's state that tells them all of a link event.
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

/** The room's snapshot, rebuilt when its link events are no longer the ones it was built from. */
function snapshotOf(room: Room): RoomPullRequests {
  const store = storeOf(room);
  const events = room.currentState.getStateEvents(THREAD_PULL_REQUEST_EVENT_TYPE);
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
    const state = room.currentState;
    const onEvent = (event: { getType(): string }) => {
      if (event.getType() !== THREAD_PULL_REQUEST_EVENT_TYPE) return;
      // The SDK redacts a link event in place, so the snapshot's events can be the same objects
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

/** Every pull request link of a room, updated when a link event arrives. */
export function useRoomPullRequests(room: Room): RoomPullRequests {
  const subscribe = useCallback((notify: () => void) => subscribeTo(room, notify), [room]);
  return useSyncExternalStore(subscribe, () => snapshotOf(room));
}

/** A thread's pull requests, and how many repositories the links of its room span. */
export type ThreadPullRequests = {
  /** In the order they were set; the same empty array when the thread has none. */
  pullRequests: readonly PullRequestRef[];
  repositories: number;
};

/** The pull requests of one thread and the room's count of repositories, from one subscription. */
export function useThreadPullRequests(
  room: Room,
  threadId: string | undefined
): ThreadPullRequests {
  const { byThread, repositories } = useRoomPullRequests(room);
  const pullRequests =
    (threadId === undefined ? undefined : byThread.get(threadId)) ?? NO_PULL_REQUESTS;
  return { pullRequests, repositories };
}
