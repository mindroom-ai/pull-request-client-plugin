// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import type { PullRequestRef } from '../github';
import plugin from '../index';
import { fnv1a32 } from './diffRendering';
import { useViewedFiles, type ViewedFiles } from './viewedFiles';

const REF = { owner: 'mindroom-ai', repo: 'mindroom-chat', number: 200 };
const KEY =
  'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/viewed:mindroom-ai/mindroom-chat#200';

let viewed: ViewedFiles;
function Probe({ pullRequest }: { pullRequest: PullRequestRef }) {
  viewed = useViewedFiles(pullRequest);
  return null;
}
const mount = (pullRequest: PullRequestRef = REF) =>
  renderPluginComponent(<Probe pullRequest={pullRequest} />, { id: 'pull-requests', plugin });
const stored = () => {
  const raw = localStorage.getItem(KEY);
  return raw === null ? null : (JSON.parse(raw) as unknown);
};

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

describe('useViewedFiles', () => {
  it('marks a file viewed with the hash of its patch, and unmarks it', async () => {
    await mount();
    expect(viewed.stateOf('src/a.ts', '@@ a')).toBe('unviewed');
    act(() => viewed.toggle('src/a.ts', '@@ a'));
    expect(viewed.stateOf('src/a.ts', '@@ a')).toBe('viewed');
    expect(stored()).toEqual({ 'src/a.ts': fnv1a32('@@ a') });
    act(() => viewed.toggle('src/a.ts', '@@ a'));
    expect(viewed.stateOf('src/a.ts', '@@ a')).toBe('unviewed');
    expect(stored()).toBeNull();
  });

  it('a file whose patch changed since is changed, and marking it again takes the new patch', async () => {
    await mount();
    act(() => viewed.toggle('src/a.ts', '@@ first'));
    expect(viewed.stateOf('src/a.ts', '@@ second')).toBe('changed');
    act(() => viewed.toggle('src/a.ts', '@@ second'));
    expect(viewed.stateOf('src/a.ts', '@@ second')).toBe('viewed');
    expect(viewed.stateOf('src/a.ts', '@@ first')).toBe('changed');
  });

  it('marks and unmarks a range at once', async () => {
    await mount();
    act(() => viewed.markRange(['a', 'b', 'c'], ['pa', 'pb', 'pc'], true));
    expect(stored()).toEqual({ a: fnv1a32('pa'), b: fnv1a32('pb'), c: fnv1a32('pc') });
    act(() => viewed.markRange(['a', 'c'], ['pa', 'pc'], false));
    expect(stored()).toEqual({ b: fnv1a32('pb') });
  });

  it('counts the files viewed with the patch they have now', async () => {
    await mount();
    act(() => viewed.markRange(['a', 'b'], ['pa', 'pb'], true));
    expect(
      viewed.viewedCount([
        { path: 'a', patch: 'pa' },
        { path: 'b', patch: 'pb, pushed to' },
        { path: 'c', patch: 'pc' },
      ])
    ).toBe(1);
  });

  it('keeps the marks of each pull request across mounts', async () => {
    const first = await mount();
    act(() => viewed.toggle('src/a.ts', '@@ a'));
    first.unmount();
    await mount();
    expect(viewed.stateOf('src/a.ts', '@@ a')).toBe('viewed');
    await mount({ ...REF, number: 201 });
    expect(viewed.stateOf('src/a.ts', '@@ a')).toBe('unviewed');
  });

  it('names no inherited property viewed', async () => {
    await mount();
    expect(viewed.stateOf('constructor', '')).toBe('unviewed');
    expect(viewed.stateOf('__proto__', '')).toBe('unviewed');
  });

  it('reads a stored value of another shape as no marks', async () => {
    await mount();
    act(() => viewed.toggle('src/a.ts', '@@ a'));
    for (const raw of ['not json', '[1]', '{"src/a.ts":"x"}']) {
      localStorage.setItem(KEY, raw);
      const view = await mount();
      expect(viewed.stateOf('src/a.ts', '@@ a')).toBe('unviewed');
      view.unmount();
    }
    await mount();
    act(() => viewed.toggle('src/b.ts', '@@ b'));
    expect(stored()).toEqual({ 'src/b.ts': fnv1a32('@@ b') });
  });
});
