// Reads which pull requests belong to a thread from the room's state, where the backend
// plugin records them: one state event per thread and pull request, empty once unlinked.

import { useSyncExternalStore } from 'react';
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

const snapshots = new WeakMap<Room, RoomPullRequests>();

function snapshotOf(room: Room): RoomPullRequests {
  let snapshot = snapshots.get(room);
  if (snapshot === undefined) {
    snapshot = readRoom(room);
    snapshots.set(room, snapshot);
  }
  return snapshot;
}

function subscribeTo(room: Room, notify: () => void): () => void {
  const state = room.currentState;
  const onEvent = (event: { getType(): string }) => {
    if (event.getType() !== THREAD_PULL_REQUEST_EVENT_TYPE) return;
    snapshots.delete(room);
    notify();
  };
  state.on(RoomStateEvent.Events, onEvent);
  return () => {
    state.off(RoomStateEvent.Events, onEvent);
  };
}

/** Every pull request link of a room, updated when a link event arrives. */
export function useRoomPullRequests(room: Room): RoomPullRequests {
  return useSyncExternalStore(
    (notify) => subscribeTo(room, notify),
    () => snapshotOf(room)
  );
}

/** The pull requests of one thread in the order they were set; the same empty array when it has none. */
export function useThreadPullRequests(
  room: Room,
  threadId: string | undefined
): readonly PullRequestRef[] {
  const { byThread } = useRoomPullRequests(room);
  return (threadId === undefined ? undefined : byThread.get(threadId)) ?? NO_PULL_REQUESTS;
}
