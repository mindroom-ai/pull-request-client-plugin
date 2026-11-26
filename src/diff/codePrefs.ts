// How the Code tab shows the diffs, kept in the plugin's storage across panels and visits: test
// files hidden or shown, whitespace changes hidden or shown, a unified or split layout, long
// lines wrapped or scrolled, the width of the Files column beside the diffs, and the line
// distribution panel's visibility, view and metric. Every open Code tab shows the same choices.
import { useMemo, useSyncExternalStore } from 'react';
import { usePluginStorage } from '@mindroom/client-sdk/core';
import type { DistributionMetric, DistributionView } from './lineDistribution.logic';
import { TREE_DEFAULT_WIDTH } from './treeWidth.logic';

export type CodePrefs = {
  hideTests: boolean;
  ignoreWhitespace: boolean;
  diffStyle: 'unified' | 'split';
  wrap: boolean;
  /** The Files column's width beside the diffs, in pixels, as chosen; it shows clamped. */
  treeWidth: number;
  showDistribution: boolean;
  distributionView: DistributionView;
  distributionMetric: DistributionMetric;
};

const KEY = 'code:prefs';

const DEFAULTS: CodePrefs = {
  hideTests: false,
  ignoreWhitespace: false,
  diffStyle: 'unified',
  wrap: true,
  treeWidth: TREE_DEFAULT_WIDTH,
  showDistribution: false,
  distributionView: 'bars',
  distributionMetric: 'total',
};

/** The stored choices, each one that does not read as a choice taking its default. */
function readCodePrefs(raw: string | null): CodePrefs {
  let value: unknown;
  try {
    value = raw === null ? null : JSON.parse(raw);
  } catch {
    value = null;
  }
  const stored =
    typeof value === 'object' && value !== null ? (value as Record<string, unknown>) : {};
  const flag = (name: 'hideTests' | 'ignoreWhitespace' | 'wrap' | 'showDistribution') => {
    const choice = stored[name];
    return typeof choice === 'boolean' ? choice : DEFAULTS[name];
  };
  return {
    hideTests: flag('hideTests'),
    ignoreWhitespace: flag('ignoreWhitespace'),
    diffStyle:
      stored.diffStyle === 'split' || stored.diffStyle === 'unified'
        ? stored.diffStyle
        : DEFAULTS.diffStyle,
    wrap: flag('wrap'),
    treeWidth:
      typeof stored.treeWidth === 'number' && Number.isFinite(stored.treeWidth)
        ? stored.treeWidth
        : DEFAULTS.treeWidth,
    showDistribution: flag('showDistribution'),
    distributionView:
      stored.distributionView === 'bars' || stored.distributionView === 'icicle'
        ? stored.distributionView
        : DEFAULTS.distributionView,
    distributionMetric:
      stored.distributionMetric === 'total' ||
      stored.distributionMetric === 'additions' ||
      stored.distributionMetric === 'net'
        ? stored.distributionMetric
        : DEFAULTS.distributionMetric,
  };
}

// Every Code tab reads the choices from storage; this set tells all of them when one changes them.
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another tab of the same account changes them too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
};

export function useCodePrefs(): CodePrefs & { update(change: Partial<CodePrefs>): void } {
  const storage = usePluginStorage('pull-requests');
  const raw = useSyncExternalStore(subscribe, () => storage.getItem(KEY));
  return useMemo(
    () => ({
      ...readCodePrefs(raw),
      update: (change: Partial<CodePrefs>) => {
        // From what is stored now, which another tab may have changed since this render read it.
        const next = { ...readCodePrefs(storage.getItem(KEY)), ...change };
        storage.setItem(KEY, JSON.stringify(next));
        listeners.forEach((listener) => listener());
      },
    }),
    [raw, storage]
  );
}
