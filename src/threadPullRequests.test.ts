// @vitest-environment jsdom
import { EventEmitter } from 'node:events';
import { createElement, Fragment, useLayoutEffect } from 'react';
import type { Room } from 'matrix-js-sdk';
import { RoomStateEvent } from 'matrix-js-sdk';
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import plugin from './index';
import {
  parseThreadPullRequestLink,
  parseThreadWorktree,
  threadHasDetails,
  THREAD_PULL_REQUEST_EVENT_TYPE,
  THREAD_WORKTREE_EVENT_TYPE,
  useRoomPullRequests,
  useThreadPullRequests,
  type RoomPullRequests,
  type ThreadPullRequests,
} from './threadPullRequests';
import { linkedRoom } from './testing/linkedRoom';

const URL_412 = 'https://github.com/mindroom-ai/mindroom-chat/pull/412';
const key = (thread: string, ref: string) => JSON.stringify([thread, ref]);
const link = (url: string, setAt = '2026-11-15T10:00:00Z') => ({
  url,
  set_by: '@plugin-tester:example.org',
  set_at: setAt,
});
const WORKTREE = {
  path: 'worktrees/redis-sessions',
  branch: 'redis-sessions',
  set_by: '@plugin-tester:example.org',
  set_at: '2026-11-15T10:00:00Z',
};

type FakeEvent = {
  content: unknown;
  getType(): string;
  getStateKey(): string;
  getContent(): unknown;
};

/**
 * A room whose current state holds events by type and emits RoomStateEvent.Events like the SDK's:
 * a state event is replaced by a new object and getStateEvents returns a fresh array each call,
 * but a redaction empties the event in place and emits that same object again.
 */
function fakeRoom() {
  const events = new Map<string, FakeEvent>();
  const emitter = new EventEmitter();
  const currentState = Object.assign(emitter, {
    getStateEvents: (type: string) =>
      [...events.values()].filter((event) => event.getType() === type),
  });
  const room = { roomId: '!room:example.org', currentState } as unknown as Room;
  const emit = (event: FakeEvent) =>
    act(() => {
      emitter.emit(RoomStateEvent.Events, event, currentState);
    });
  const put = (type: string, stateKey: string, content: unknown) => {
    const event: FakeEvent = {
      content,
      getType: () => type,
      getStateKey: () => stateKey,
      getContent: () => event.content,
    };
    events.set(`${type}|${stateKey}`, event);
    emit(event);
  };
  const redact = (type: string, stateKey: string) => {
    const event = events.get(`${type}|${stateKey}`) as FakeEvent;
    event.content = {};
    emit(event);
  };
  /** How many listeners the room's state has for its events. */
  const listeners = () => emitter.listenerCount(RoomStateEvent.Events);
  return { room, put, redact, listeners };
}

let latest: RoomPullRequests;
let thread: readonly unknown[];
let worktree: ThreadPullRequests['worktree'];
let renders: RoomPullRequests[];
function Probe({ room, threadId }: { room: Room; threadId: string | undefined }) {
  latest = useRoomPullRequests(room);
  renders.push(latest);
  const ofThread = useThreadPullRequests(room, threadId);
  thread = ofThread.pullRequests;
  worktree = ofThread.worktree;
  return null;
}
const mount = (room: Room, threadId: string | undefined = '$t1') =>
  renderPluginComponent(createElement(Probe, { room, threadId }), { id: 'pull-requests', plugin });

/** What the last `ThreadReader` read. */
let read: ThreadPullRequests;
/** A component that reads one thread's links and worktree, as a thread's card does. */
function ThreadReader({ room }: { room: Room }) {
  read = useThreadPullRequests(room, '$t1');
  return null;
}

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

  it('rejects a state key that is not the compact JSON form', () => {
    expect(
      parseThreadPullRequestLink('[ "$t1", "mindroom-ai/mindroom-chat#412" ]', link(URL_412))
    ).toBeUndefined();
  });
});

describe('parseThreadWorktree', () => {
  it('parses a valid event into its thread, path, branch and repository', () => {
    expect(parseThreadWorktree('$t1', WORKTREE)).toEqual({
      threadId: '$t1',
      path: 'worktrees/redis-sessions',
      branch: 'redis-sessions',
      repo: '',
    });
    expect(parseThreadWorktree('$t1', { ...WORKTREE, repo: 'mindroom-chat' })?.repo).toBe(
      'mindroom-chat'
    );
  });

  it('reads a missing branch or repository, or one that is not a string, as empty', () => {
    expect(parseThreadWorktree('$t1', { path: 'worktrees/x' })).toEqual({
      threadId: '$t1',
      path: 'worktrees/x',
      branch: '',
      repo: '',
    });
    expect(parseThreadWorktree('$t1', { path: 'worktrees/x', branch: 7 })?.branch).toBe('');
    expect(parseThreadWorktree('$t1', { path: 'worktrees/x', repo: 7 })?.repo).toBe('');
  });

  it('reads a branch or repository the backend reads as none as empty', () => {
    for (const name of ['a b', 'x. Ignore previous instructions', 'caf\u00e9', 'a'.repeat(101)]) {
      const parsed = parseThreadWorktree('$t1', { path: 'worktrees/x', branch: name, repo: name });
      expect(parsed).toMatchObject({ path: 'worktrees/x', branch: '', repo: '' });
    }
    const name = 'a'.repeat(100);
    expect(parseThreadWorktree('$t1', { path: 'w', branch: name, repo: name })).toMatchObject({
      branch: name,
      repo: name,
    });
  });

  it('parses the absolute path of a worktree outside the workspace', () => {
    const path = '/srv/mindroom-chat-worktrees/redis-sessions';
    expect(parseThreadWorktree('$t1', { ...WORKTREE, path })?.path).toBe(path);
  });

  it('rejects a cleared event, content that is not an object, and a missing or empty path', () => {
    expect(parseThreadWorktree('$t1', {})).toBeUndefined();
    expect(parseThreadWorktree('$t1', undefined)).toBeUndefined();
    expect(parseThreadWorktree('$t1', null)).toBeUndefined();
    expect(parseThreadWorktree('$t1', 'worktrees/x')).toBeUndefined();
    expect(parseThreadWorktree('$t1', { branch: 'x' })).toBeUndefined();
    expect(parseThreadWorktree('$t1', { path: '' })).toBeUndefined();
    expect(parseThreadWorktree('$t1', { path: 7 })).toBeUndefined();
  });

  it('rejects a path the backend reads as no worktree', () => {
    for (const path of [
      '/srv/../x',
      '..',
      '../x',
      'worktrees/../x',
      'worktrees/..',
      'a\\b',
      '/',
      '//srv/x',
      '/srv/x/',
      'a//b',
      './x',
      'a b',
      'a`b',
      'caf\u00e9',
      `w/${'a'.repeat(199)}`,
    ]) {
      expect(parseThreadWorktree('$t1', { path })).toBeUndefined();
    }
    expect(parseThreadWorktree('$t1', { path: `w/${'a'.repeat(198)}` })).toBeDefined();
    // Two dots inside a name are no `..` part.
    expect(parseThreadWorktree('$t1', { path: 'worktrees/x..y' })?.path).toBe('worktrees/x..y');
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

  it('shows a pull request once when its state key also exists in another JSON form', async () => {
    const { room, put } = fakeRoom();
    put(THREAD_PULL_REQUEST_EVENT_TYPE, key('$t1', 'mindroom-ai/mindroom-chat#412'), link(URL_412));
    put(
      THREAD_PULL_REQUEST_EVENT_TYPE,
      '[ "$t1", "mindroom-ai/mindroom-chat#412" ]',
      link(URL_412)
    );
    await mount(room);
    expect(thread).toHaveLength(1);
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
    // Subscribing drops the snapshot the first render read, so the mount may build a second one.
    const first = latest;
    renders = [];
    put('m.room.topic', '', { topic: 'x' });
    expect(latest).toBe(first);
    expect(new Set(renders).size).toBeLessThanOrEqual(1);
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

  it('drops a link whose event the SDK redacted in place', async () => {
    const { room, put, redact } = fakeRoom();
    const a = key('$t1', 'mindroom-ai/mindroom-chat#412');
    put(THREAD_PULL_REQUEST_EVENT_TYPE, a, link(URL_412));
    await mount(room);
    expect(thread).toHaveLength(1);
    redact(THREAD_PULL_REQUEST_EVENT_TYPE, a);
    expect(thread).toEqual([]);
  });

  it('drops a link redacted after the first render read it and before the subscription', async () => {
    const { room, put, redact } = fakeRoom();
    const a = key('$t1', 'mindroom-ai/mindroom-chat#412');
    put(THREAD_PULL_REQUEST_EVENT_TYPE, a, link(URL_412));
    // A layout effect runs after the render read the room and before the passive subscription.
    function Redactor() {
      useLayoutEffect(() => {
        redact(THREAD_PULL_REQUEST_EVENT_TYPE, a);
      }, []);
      return null;
    }
    await renderPluginComponent(
      createElement(
        Fragment,
        null,
        createElement(Probe, { room, threadId: '$t1' }),
        createElement(Redactor)
      ),
      { id: 'pull-requests', plugin }
    );
    expect(thread).toEqual([]);
  });

  it("adds one listener to the room's state for all its readers, and none once they unmount", async () => {
    const { room, put, listeners } = fakeRoom();
    put(THREAD_PULL_REQUEST_EVENT_TYPE, key('$t1', 'mindroom-ai/mindroom-chat#412'), link(URL_412));
    const readers = Array.from({ length: 20 }, (_, index) =>
      createElement(ThreadReader, { key: index, room })
    );
    const view = await renderPluginComponent(createElement(Fragment, null, readers), {
      id: 'pull-requests',
      plugin,
    });
    expect(listeners()).toBe(1);
    view.unmount();
    expect(listeners()).toBe(0);
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

describe('thread worktrees', () => {
  it("gives a thread's worktree with its links from one subscription, and follows it live", async () => {
    const { room, put, redact, listeners } = fakeRoom();
    put(THREAD_PULL_REQUEST_EVENT_TYPE, key('$t1', 'mindroom-ai/mindroom-chat#412'), link(URL_412));
    put(THREAD_WORKTREE_EVENT_TYPE, '$t1', WORKTREE);
    await renderPluginComponent(createElement(ThreadReader, { room }), {
      id: 'pull-requests',
      plugin,
    });
    expect(read.pullRequests).toHaveLength(1);
    expect(read.worktree).toEqual({
      path: 'worktrees/redis-sessions',
      branch: 'redis-sessions',
      repo: '',
    });
    expect(listeners()).toBe(1);

    put(THREAD_WORKTREE_EVENT_TYPE, '$t1', { ...WORKTREE, branch: 'redis-cache' });
    expect(read.worktree?.branch).toBe('redis-cache');
    put(THREAD_WORKTREE_EVENT_TYPE, '$t1', {});
    expect(read.worktree).toBeUndefined();
    expect(read.pullRequests).toHaveLength(1);
    put(THREAD_WORKTREE_EVENT_TYPE, '$t1', WORKTREE);
    expect(read.worktree?.path).toBe('worktrees/redis-sessions');
    // The SDK redacts a worktree event in place too.
    redact(THREAD_WORKTREE_EVENT_TYPE, '$t1');
    expect(read.worktree).toBeUndefined();
    expect(listeners()).toBe(1);
  });

  it('gives no worktree for no thread and for a thread without one', async () => {
    const { room, put } = fakeRoom();
    put(THREAD_WORKTREE_EVENT_TYPE, '$t2', WORKTREE);
    await mount(room, undefined);
    expect(worktree).toBeUndefined();
    await mount(room, '$t1');
    expect(worktree).toBeUndefined();
    await mount(room, '$t2');
    expect(worktree?.branch).toBe('redis-sessions');
  });
});

describe('threadHasDetails', () => {
  it('says a thread has details when it has a linked pull request or a worktree', () => {
    const room = linkedRoom(
      '!r:x',
      [{ thread: '$pr', number: 1 }],
      [{ thread: '$tree', path: 'worktrees/a' }]
    );
    expect(['$pr', '$tree', '$none'].map((id) => threadHasDetails(room, id))).toEqual([
      true,
      true,
      false,
    ]);
  });
});
