// Which pull request each room's side panel shows: the panel records it, and the open thread's
// pull requests menu reads it to mark that pull request's item.
import { useSyncExternalStore } from 'react';
import type { PullRequestRef } from './github';

const shown = new Map<string, PullRequestRef>();
const listeners = new Set<() => void>();

/** Records that the panel of the room `roomId` shows `pullRequest`, or none. */
export function setShownPullRequest(roomId: string, pullRequest: PullRequestRef | undefined): void {
  if (shown.get(roomId) === pullRequest) return;
  if (pullRequest === undefined) shown.delete(roomId);
  else shown.set(roomId, pullRequest);
  for (const listener of listeners) listener();
}

/**
 * Clears the record of the room `roomId` while it is still `pullRequest`: a panel that took the
 * place of the one that set it may have recorded its own already.
 */
export function clearShownPullRequest(
  roomId: string,
  pullRequest: PullRequestRef | undefined
): void {
  if (shown.get(roomId) === pullRequest) setShownPullRequest(roomId, undefined);
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The pull request the panel of the room `roomId` shows, rendered again when it changes. */
export function useShownPullRequest(roomId: string): PullRequestRef | undefined {
  return useSyncExternalStore(subscribe, () => shown.get(roomId));
}
