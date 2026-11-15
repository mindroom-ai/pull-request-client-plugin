// A room for tests whose state links pull requests to threads, as the backend plugin records them.
import type { Room } from 'matrix-js-sdk';
import { THREAD_PULL_REQUEST_EVENT_TYPE } from '../threadPullRequests';

/** A pull request of `mindroom-ai` linked to a thread, `$t1` and `mindroom-chat` unless given. */
export type TestLink = { thread?: string; repo?: string; number: number };

/** A room `roomId` whose state links each pull request of `links`, set in the order given. */
export function linkedRoom(roomId: string, links: TestLink[]): Room {
  const events = links.map(({ thread = '$t1', repo = 'mindroom-chat', number }, index) => ({
    getType: () => THREAD_PULL_REQUEST_EVENT_TYPE,
    getStateKey: () => JSON.stringify([thread, `mindroom-ai/${repo}#${number}`]),
    getContent: () => ({
      url: `https://github.com/mindroom-ai/${repo}/pull/${number}`,
      set_by: '@plugin-tester:example.org',
      set_at: `2026-11-15T10:0${index}:00Z`,
    }),
  }));
  // The links never change, so nothing is ever emitted.
  const currentState = {
    getStateEvents: () => events,
    on: () => undefined,
    off: () => undefined,
  };
  return { roomId, currentState } as unknown as Room;
}
