// @vitest-environment jsdom
import { act } from 'react-dom/test-utils';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { beforeEach, describe, expect, it } from 'vitest';
import plugin from '../index';
import { useCodePrefs } from './codePrefs';

const KEY = 'mindroom.plugin:%40plugin-tester%3Aexample.org/pull-requests/code:prefs';

let prefs: ReturnType<typeof useCodePrefs>;
function Probe() {
  prefs = useCodePrefs();
  return null;
}
// A second reader of the same choices, as another open Code tab is.
let other: ReturnType<typeof useCodePrefs>;
function OtherProbe() {
  other = useCodePrefs();
  return null;
}
const mount = () => renderPluginComponent(<Probe />, { id: 'pull-requests', plugin });
const values = () => ({
  hideTests: prefs.hideTests,
  ignoreWhitespace: prefs.ignoreWhitespace,
  diffStyle: prefs.diffStyle,
  wrap: prefs.wrap,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

describe('useCodePrefs', () => {
  it('starts unified and wrapped, with test files and whitespace changes shown', async () => {
    await mount();
    expect(values()).toEqual({
      hideTests: false,
      ignoreWhitespace: false,
      diffStyle: 'unified',
      wrap: true,
    });
  });

  it('keeps a change across mounts', async () => {
    const first = await mount();
    act(() => prefs.update({ diffStyle: 'split', hideTests: true }));
    expect(values()).toMatchObject({ diffStyle: 'split', hideTests: true });
    act(() => prefs.update({ wrap: false }));
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
      hideTests: true,
      ignoreWhitespace: false,
      diffStyle: 'split',
      wrap: false,
    });
    first.unmount();
    await mount();
    expect(values()).toEqual({
      hideTests: true,
      ignoreWhitespace: false,
      diffStyle: 'split',
      wrap: false,
    });
  });

  it('one change reaches every mounted reader', async () => {
    await renderPluginComponent(
      <>
        <Probe />
        <OtherProbe />
      </>,
      { id: 'pull-requests', plugin }
    );
    act(() => prefs.update({ diffStyle: 'split' }));
    expect(other.diffStyle).toBe('split');
    act(() => other.update({ hideTests: true }));
    expect(values()).toMatchObject({ diffStyle: 'split', hideTests: true });
  });

  it('takes each stored value it can read and the default for the rest', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({ hideTests: true, ignoreWhitespace: 'yes', diffStyle: 'sideways' })
    );
    const first = await mount();
    expect(values()).toEqual({
      hideTests: true,
      ignoreWhitespace: false,
      diffStyle: 'unified',
      wrap: true,
    });
    first.unmount();
    localStorage.setItem(KEY, 'not json');
    await mount();
    expect(values()).toMatchObject({ hideTests: false, diffStyle: 'unified' });
  });
});
