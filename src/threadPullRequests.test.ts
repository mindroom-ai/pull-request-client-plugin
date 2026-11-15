// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { createElement } from 'react';
import type { Room } from 'matrix-js-sdk';
import { RoomStateEvent } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import plugin from './index';
import {
  parseThreadPullRequestLink,
  THREAD_PULL_REQUEST_EVENT_TYPE,
  useRoomPullRequests,
  useThreadPullRequests,
  type RoomPullRequests,
} from './threadPullRequests';

const URL_412 = 'https://github.com/mindroom-ai/mindroom-chat/pull/412';
const key = (thread: string, ref: string) => JSON.stringify([thread, ref]);
const link = (url: string, setAt = '2026-11-15T10:00:00Z') => ({
  url,
  set_by: '@plugin-tester:example.org',
  set_at: setAt,
});

type FakeEvent = {
  getType(): string;
  getStateKey(): string;
  getContent(): unknown;
};

/**
 * A room whose current state holds events by type and emits RoomStateEvent.Events like the SDK's:
 * a state event is replaced by a new object and getStateEvents returns a fresh array each call.
 */
function fakeRoom() {
  const events = new Map<string, FakeEvent>();
  const emitter = new EventEmitter();
  const currentState = Object.assign(emitter, {
    getStateEvents: (type: string) =>
      [...events.values()].filter((event) => event.getType() === type),
  });
  const room = { roomId: '!room:example.org', currentState } as unknown as Room;
  const put = (type: string, stateKey: string, content: unknown) => {
    const event: FakeEvent = {
      getType: () => type,
      getStateKey: () => stateKey,
      getContent: () => content,
    };
    events.set(`${type}|${stateKey}`, event);
    act(() => {
      emitter.emit(RoomStateEvent.Events, event, currentState);
    });
  };
  return { room, put };
}

let latest: RoomPullRequests;
let thread: readonly unknown[];
let renders: RoomPullRequests[];
function Probe({ room, threadId }: { room: Room; threadId: string | undefined }) {
  latest = useRoomPullRequests(room);
  renders.push(latest);
  thread = useThreadPullRequests(room, threadId);
  return null;
}
const mount = (room: Room, threadId: string | undefined = '$t1') =>
  renderPluginComponent(createElement(Probe, { room, threadId }), { id: 'pull-requests', plugin });

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  renders = [];
});

describe('parseThreadPullRequestLink', () => {
  it('parses a valid event into its thread and pull request', () => {
    expect(
      parseThreadPullRequestLink(key('$t1', 'mindroom-ai/mindroom-chat#412'), link(URL_412))
    ).toEqual({
      threadId: '$t1',
      pullRequest: { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 412 },
      setAt: '2026-11-15T10:00:00Z',
    });
  });

  it('lower-cases the owner and repository of the url', () => {
    const parsed = parseThreadPullRequestLink(
      key('$t1', 'mindroom-ai/mindroom-chat#412'),
      link('https://github.com/Mindroom-AI/mindroom-chat/pull/412/files')
    );
    expect(parsed?.pullRequest).toEqual({
      owner: 'mindroom-ai',
      repo: 'mindroom-chat',
      number: 412,
    });
  });

  it('rejects an unlinked event, a malformed key, a foreign url and a mismatched key', () => {
    const good = key('$t1', 'mindroom-ai/mindroom-chat#412');
    expect(parseThreadPullRequestLink(good, {})).toBeUndefined();
    expect(parseThreadPullRequestLink(good, undefined)).toBeUndefined();
    expect(parseThreadPullRequestLink('not json', link(URL_412))).toBeUndefined();
    expect(parseThreadPullRequestLink('{"a":1}', link(URL_412))).toBeUndefined();
    expect(parseThreadPullRequestLink(JSON.stringify(['$t1']), link(URL_412))).toBeUndefined();
    expect(parseThreadPullRequestLink(JSON.stringify(['$t1', 7]), link(URL_412))).toBeUndefined();
    expect(
      parseThreadPullRequestLink(
        good,
        link('https://example.com/mindroom-ai/mindroom-chat/pull/412')
      )
    ).toBeUndefined();
    expect(parseThreadPullRequestLink(good, { ...link(URL_412), url: 'nope' })).toBeUndefined();
    expect(
      parseThreadPullRequestLink(key('$t1', 'mindroom-ai/mindroom-chat#413'), link(URL_412))
    ).toBeUndefined();
  });
});

describe('room pull requests', () => {
  it('lists the links of a thread in set_at order, drops an unlinked one and shows it again when set again', async () => {
    const { room, put } = fakeRoom();
    const a = key('$t1', 'mindroom-ai/mindroom-chat#412');
    const b = key('$t1', 'mindroom-ai/mindroom-chat#9');
    put(THREAD_PULL_REQUEST_EVENT_TYPE, a, link(URL_412, '2026-11-15T12:00:00Z'));
    put(
      THREAD_PULL_REQUEST_EVENT_TYPE,
      b,
      link('https://github.com/mindroom-ai/mindroom-chat/pull/9', '2026-11-15T11:00:00Z')
    );
    await mount(room);
    expect(thread.map((ref) => (ref as { number: number }).number)).toEqual([9, 412]);
    expect(latest.repositories).toBe(1);

    put(THREAD_PULL_REQUEST_EVENT_TYPE, b, {});
    expect(thread.map((ref) => (ref as { number: number }).number)).toEqual([412]);

    put(
      THREAD_PULL_REQUEST_EVENT_TYPE,
      b,
      link('https://github.com/mindroom-ai/mindroom-chat/pull/9', '2026-11-15T13:00:00Z')
    );
    expect(thread.map((ref) => (ref as { number: number }).number)).toEqual([412, 9]);
  });

  it('counts distinct repositories across threads', async () => {
    const { room, put } = fakeRoom();
    put(THREAD_PULL_REQUEST_EVENT_TYPE, key('$t1', 'mindroom-ai/mindroom-chat#412'), link(URL_412));
    put(
      THREAD_PULL_REQUEST_EVENT_TYPE,
      key('$t2', 'mindroom-ai/mindroom#5'),
      link('https://github.com/mindroom-ai/mindroom/pull/5')
    );
    await mount(room);
    expect(latest.repositories).toBe(2);
    expect(latest.byThread.get('$t2')).toHaveLength(1);
  });

  it('keeps the same snapshot across renders and other state events, and a new one after a link event', async () => {
    const { room, put } = fakeRoom();
    put(THREAD_PULL_REQUEST_EVENT_TYPE, key('$t1', 'mindroom-ai/mindroom-chat#412'), link(URL_412));
    await mount(room);
    const first = latest;
    put('m.room.topic', '', { topic: 'x' });
    expect(latest).toBe(first);
    expect(new Set(renders).size).toBe(1);
    put(
      THREAD_PULL_REQUEST_EVENT_TYPE,
      key('$t1', 'mindroom-ai/mindroom-chat#9'),
      link('https://github.com/mindroom-ai/mindroom-chat/pull/9')
    );
    expect(latest).not.toBe(first);
  });

  it('shows a link set while nothing was mounted to a hook mounted afterwards', async () => {
    const { room, put } = fakeRoom();
    put(
      THREAD_PULL_REQUEST_EVENT_TYPE,
      key('$t1', 'mindroom-ai/mindroom-chat#9'),
      link('https://github.com/mindroom-ai/mindroom-chat/pull/9')
    );
    const first = await mount(room);
    expect(thread).toHaveLength(1);
    first.unmount();
    put(THREAD_PULL_REQUEST_EVENT_TYPE, key('$t1', 'mindroom-ai/mindroom-chat#412'), link(URL_412));
    await mount(room);
    expect(thread.map((ref) => (ref as { number: number }).number)).toEqual([9, 412]);
  });

  it('gives the same empty array for no thread and for a thread without links', async () => {
    const { room } = fakeRoom();
    await mount(room, undefined);
    const none = thread;
    expect(none).toEqual([]);
    await mount(room, '$other');
    expect(thread).toBe(none);
  });
});
