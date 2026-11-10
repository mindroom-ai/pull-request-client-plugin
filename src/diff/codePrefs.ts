// How the Code tab shows the diffs, kept in the plugin's storage across panels and visits: test
// files hidden or shown, whitespace changes hidden or shown, a unified or split layout, and long
// lines wrapped or scrolled.
import { useMemo, useState } from 'react';
import { usePluginStorage } from '@mindroom/client-sdk/core';

export type CodePrefs = {
  hideTests: boolean;
  ignoreWhitespace: boolean;
  diffStyle: 'unified' | 'split';
  wrap: boolean;
};

const KEY = 'code:prefs';

const DEFAULTS: CodePrefs = {
  hideTests: false,
  ignoreWhitespace: false,
  diffStyle: 'unified',
  wrap: true,
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
  const flag = (name: 'hideTests' | 'ignoreWhitespace' | 'wrap') => {
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
  };
}

export function useCodePrefs(): CodePrefs & { update(change: Partial<CodePrefs>): void } {
  const storage = usePluginStorage('pull-requests');
  const [prefs, setPrefs] = useState(() => readCodePrefs(storage.getItem(KEY)));
  return useMemo(
    () => ({
      ...prefs,
      update: (change: Partial<CodePrefs>) => {
        const next = { ...prefs, ...change };
        setPrefs(next);
        storage.setItem(KEY, JSON.stringify(next));
      },
    }),
    [prefs, storage]
  );
}
