// The Code tab's viewed marks, kept in the browser: GitHub's REST API has no viewed state of its
// own. Each pull request keeps the paths marked viewed, each with a hash of the patch it had then,
// so a file pushed to since reads as changed rather than viewed.
import { useMemo, useSyncExternalStore } from 'react';
import { usePluginStorage, type PluginStorage } from '@mindroom/client-sdk/core';
import type { PullRequestRef } from '../github';
import { fnv1a32 } from './diffRendering';

export type ViewedState = 'unviewed' | 'viewed' | 'changed';

export type ViewedFiles = {
  stateOf(path: string, patch: string): ViewedState;
  /** Marks a file viewed with its patch, or unmarks it when it is viewed with that patch. */
  toggle(path: string, patch: string): void;
  /** Marks each path viewed with the patch at the same place, or unmarks each. */
  markRange(paths: ReadonlyArray<string>, patches: ReadonlyArray<string>, viewed: boolean): void;
  /** How many of the files are viewed with the patch they have now. */
  viewedCount(files: ReadonlyArray<{ path: string; patch: string }>): number;
};

const viewedKey = (ref: PullRequestRef) => `viewed:${ref.owner}/${ref.repo}#${ref.number}`;

// Every Code tab reads the marks from storage; this set tells all of them when one changes them.
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
  listeners.add(listener);
  // Another tab of the same account marks files too.
  window.addEventListener('storage', listener);
  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', listener);
  };
};

/** The stored marks, path to patch hash; a value of another shape counts as none. */
function parseMarks(raw: string | null): Map<string, number> {
  if (raw === null) return new Map();
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return new Map();
    return new Map(
      Object.entries(value).filter(
        (entry): entry is [string, number] => typeof entry[1] === 'number'
      )
    );
  } catch {
    return new Map();
  }
}

function writeMarks(storage: PluginStorage, key: string, marks: Map<string, number>) {
  if (marks.size === 0) storage.removeItem(key);
  else storage.setItem(key, JSON.stringify(Object.fromEntries(marks)));
  listeners.forEach((listener) => listener());
}

/** The viewed marks of the files of one pull request, in the plugin's storage. */
export function useViewedFiles(ref: PullRequestRef): ViewedFiles {
  const storage = usePluginStorage('pull-requests');
  const key = viewedKey(ref);
  const raw = useSyncExternalStore(subscribe, () => storage.getItem(key));
  return useMemo(() => {
    const marks = parseMarks(raw);
    const stateOf = (path: string, patch: string): ViewedState => {
      const hash = marks.get(path);
      if (hash === undefined) return 'unviewed';
      return hash === fnv1a32(patch) ? 'viewed' : 'changed';
    };
    // A change starts from what is stored now, which another change may have written since this
    // render read it.
    const change = (apply: (current: Map<string, number>) => void) => {
      const current = parseMarks(storage.getItem(key));
      apply(current);
      writeMarks(storage, key, current);
    };
    return {
      stateOf,
      toggle: (path, patch) =>
        change((current) => {
          const hash = fnv1a32(patch);
          if (current.get(path) === hash) current.delete(path);
          else current.set(path, hash);
        }),
      markRange: (paths, patches, viewed) =>
        change((current) => {
          paths.forEach((path, index) => {
            if (viewed) current.set(path, fnv1a32(patches[index] ?? ''));
            else current.delete(path);
          });
        }),
      viewedCount: (files) =>
        files.filter((file) => stateOf(file.path, file.patch) === 'viewed').length,
    };
  }, [key, raw, storage]);
}
