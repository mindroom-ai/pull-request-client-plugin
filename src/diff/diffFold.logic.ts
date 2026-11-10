// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDiff.logic.ts and apps/web/src/lib/diffCollapse.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Which diffs of the Code tab are folded, and which files a Shift-click on a viewed mark covers.

/** What the toolbar's collapse or expand all last asked for; null while it has not been used. */
export type DiffFoldOverride = 'expanded' | 'folded' | null;

/** Fold choices are kept relative to the toolbar's, so a file folds against what it asked for. */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>
): boolean {
  const foldedByDefault = foldOverride === 'folded';
  return toggledFileKeys.has(fileKey) ? !foldedByDefault : foldedByDefault;
}

/** Folds a file marked viewed and unfolds one unmarked, leaving one already so as it is. */
export function toggleFileDiffFoldForViewed(
  fileKey: string,
  viewed: boolean,
  foldOverride: DiffFoldOverride,
  toggledFileKeys: ReadonlySet<string>
): ReadonlySet<string> {
  if (isFileDiffCollapsed(fileKey, foldOverride, toggledFileKeys) === viewed) {
    return toggledFileKeys;
  }
  const next = new Set(toggledFileKeys);
  if (next.has(fileKey)) next.delete(fileKey);
  else next.add(fileKey);
  return next;
}

/**
 * The files from the anchor (the file last marked) to `fileKey`, both included, in the order
 * shown; only `fileKey` without an anchor that is still shown, and none when it is not shown.
 */
export function getFileViewedRange<T extends { readonly fileKey: string }>(
  files: ReadonlyArray<T>,
  fileKey: string,
  anchorFileKey: string | null
): ReadonlyArray<T> {
  const index = files.findIndex((file) => file.fileKey === fileKey);
  if (index === -1) return [];
  const anchorIndex = files.findIndex((file) => file.fileKey === anchorFileKey);
  if (anchorIndex === -1) return files.slice(index, index + 1);
  return files.slice(Math.min(index, anchorIndex), Math.max(index, anchorIndex) + 1);
}

export function areAllDiffFilesCollapsed(
  fileKeys: ReadonlyArray<string>,
  collapsedFileKeys: ReadonlySet<string>
): boolean {
  return fileKeys.length > 0 && fileKeys.every((fileKey) => collapsedFileKeys.has(fileKey));
}
