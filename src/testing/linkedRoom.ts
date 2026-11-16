// A room for tests whose state links pull requests to threads and gives threads their worktrees,
// as the backend plugins record them.
import type { Room } from 'matrix-js-sdk';
import { THREAD_PULL_REQUEST_EVENT_TYPE, THREAD_WORKTREE_EVENT_TYPE } from '../threadPullRequests';

/** A pull request of `mindroom-ai` linked to a thread, `$t1` and `mindroom-chat` unless given. */
export type TestLink = { thread?: string; repo?: string; number: number };

/** The worktree of a thread, `$t1` unless given. */
export type TestWorktree = { thread?: string; path: string; branch?: string; repo?: string };

/**
 * A room `roomId` whose state links each pull request of `links`, set in the order given, and
 * records each worktree of `worktrees`.
 */
export function linkedRoom(
  roomId: string,
  links: TestLink[],
  worktrees: TestWorktree[] = []
): Room {
  const linkEvents = links.map(({ thread = '$t1', repo = 'mindroom-chat', number }, index) => ({
    getType: () => THREAD_PULL_REQUEST_EVENT_TYPE,
    getStateKey: () => JSON.stringify([thread, `mindroom-ai/${repo}#${number}`]),
    getContent: () => ({
      url: `https://github.com/mindroom-ai/${repo}/pull/${number}`,
      set_by: '@plugin-tester:example.org',
      set_at: `2026-11-15T10:0${index}:00Z`,
    }),
  }));
  const worktreeEvents = worktrees.map(({ thread = '$t1', path, branch, repo }) => ({
    getType: () => THREAD_WORKTREE_EVENT_TYPE,
    getStateKey: () => thread,
    getContent: () => ({
      path,
      branch,
      repo,
      set_by: '@plugin-tester:example.org',
      set_at: '2026-11-15T10:00:00Z',
    }),
  }));
  const events = [...linkEvents, ...worktreeEvents];
  // The state never changes, so nothing is ever emitted.
  const currentState = {
    getStateEvents: (type: string) => events.filter((event) => event.getType() === type),
    on: () => undefined,
    off: () => undefined,
  };
  return { roomId, currentState } as unknown as Room;
}
