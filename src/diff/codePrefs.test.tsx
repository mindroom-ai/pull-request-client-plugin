// @vitest-environment jsdom
import { act } from '../testing/act';
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
  treeWidth: prefs.treeWidth,
  showDistribution: prefs.showDistribution,
  distributionView: prefs.distributionView,
  distributionMetric: prefs.distributionMetric,
});

beforeEach(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  localStorage.clear();
});

describe('useCodePrefs', () => {
  it('starts unified and wrapped, with test files, whitespace shown and distribution closed', async () => {
    await mount();
    expect(values()).toEqual({
      hideTests: false,
      ignoreWhitespace: false,
      diffStyle: 'unified',
      wrap: true,
      treeWidth: 240,
      showDistribution: false,
      distributionView: 'bars',
      distributionMetric: 'total',
    });
  });

  it('keeps a change across mounts', async () => {
    const first = await mount();
    act(() => prefs.update({ diffStyle: 'split', hideTests: true }));
    expect(values()).toMatchObject({ diffStyle: 'split', hideTests: true });
    act(() => prefs.update({ wrap: false }));
    act(() =>
      prefs.update({
        treeWidth: 320,
        showDistribution: true,
        distributionView: 'icicle',
        distributionMetric: 'additions',
      })
    );
    expect(JSON.parse(localStorage.getItem(KEY) ?? 'null')).toEqual({
      hideTests: true,
      ignoreWhitespace: false,
      diffStyle: 'split',
      wrap: false,
      treeWidth: 320,
      showDistribution: true,
      distributionView: 'icicle',
      distributionMetric: 'additions',
    });
    first.unmount();
    await mount();
    expect(values()).toEqual({
      hideTests: true,
      ignoreWhitespace: false,
      diffStyle: 'split',
      wrap: false,
      treeWidth: 320,
      showDistribution: true,
      distributionView: 'icicle',
      distributionMetric: 'additions',
    });
    act(() => prefs.update({ distributionMetric: 'net' }));
    expect(values().distributionMetric).toBe('net');
    const reopened = await mount();
    expect(values().distributionMetric).toBe('net');
    reopened.unmount();
  });

  it('one change reaches every mounted reader', async () => {
    await renderPluginComponent(
      <>
        <Probe />
        <OtherProbe />
      </>,
      { id: 'pull-requests', plugin }
    );
    act(() => prefs.update({ diffStyle: 'split', showDistribution: true }));
    expect(other.diffStyle).toBe('split');
    expect(other.showDistribution).toBe(true);
    act(() => other.update({ hideTests: true, distributionView: 'icicle' }));
    expect(values()).toMatchObject({
      diffStyle: 'split',
      hideTests: true,
      showDistribution: true,
      distributionView: 'icicle',
    });
  });

  it('takes each stored value it can read and the default for the rest', async () => {
    localStorage.setItem(
      KEY,
      JSON.stringify({
        hideTests: true,
        ignoreWhitespace: 'yes',
        diffStyle: 'sideways',
        showDistribution: 'on',
        distributionView: 'treemap',
        distributionMetric: 'deletions',
      })
    );
    const first = await mount();
    expect(values()).toEqual({
      hideTests: true,
      ignoreWhitespace: false,
      diffStyle: 'unified',
      wrap: true,
      treeWidth: 240,
      showDistribution: false,
      distributionView: 'bars',
      distributionMetric: 'total',
    });
    first.unmount();
    localStorage.setItem(KEY, JSON.stringify({ wrap: false, treeWidth: '300px' }));
    const second = await mount();
    expect(values()).toMatchObject({ wrap: false, treeWidth: 240 });
    second.unmount();
    localStorage.setItem(KEY, JSON.stringify({ hideTests: true, treeWidth: null }));
    const third = await mount();
    expect(values()).toMatchObject({ hideTests: true, treeWidth: 240 });
    act(() => prefs.update({ treeWidth: 300 }));
    expect(values()).toMatchObject({ hideTests: true, treeWidth: 300 });
    third.unmount();
    localStorage.setItem(KEY, 'not json');
    await mount();
    expect(values()).toMatchObject({
      hideTests: false,
      diffStyle: 'unified',
      showDistribution: false,
      distributionView: 'bars',
      distributionMetric: 'total',
    });
  });
});
