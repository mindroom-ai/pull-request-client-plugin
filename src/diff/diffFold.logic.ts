// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDiff.logic.ts, apps/web/src/lib/diffCollapse.ts and packages/client-runtime/src/pullRequestDiffFold.ts at 1f698f01d9), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Which diffs of the Code tab are folded, and which files a Shift-click on a viewed mark covers.

/** What the toolbar's collapse or expand all last asked for; null while it has not been used. */
export type DiffFoldOverride = 'expanded' | 'folded' | null;

/** The reader's own fold of each file. It is absolute, so a viewed mark that changes keeps it. */
export type FileDiffFoldChoices = ReadonlyMap<string, boolean>;

/**
 * A reader's own fold wins. Otherwise the toolbar's collapse or expand all decides, and before it
 * is used a file is folded while it is viewed, as GitHub folds it.
 */
export function isFileDiffCollapsed(
  fileKey: string,
  foldOverride: DiffFoldOverride,
  choices: FileDiffFoldChoices,
  viewed = false
): boolean {
  return choices.get(fileKey) ?? (foldOverride === null ? viewed : foldOverride === 'folded');
}

/** Records the reader's fold of a file, or clears it with undefined. */
export function withFileDiffFold(
  choices: FileDiffFoldChoices,
  fileKey: string,
  collapsed: boolean | undefined
): FileDiffFoldChoices {
  if (choices.get(fileKey) === collapsed) return choices;
  const next = new Map(choices);
  if (collapsed === undefined) next.delete(fileKey);
  else next.set(fileKey, collapsed);
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
