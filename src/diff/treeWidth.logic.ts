// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/files/FileExplorerPane.tsx and hooks/useResizableWidth.ts at 943de8fe), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The width of the Code tab's Files column beside the diffs: 240px until a person drags or steps
// it, at least 192px, and at most 560px or what leaves the diffs 256px of the Code body, whichever
// is less. A stored width outside these shows clamped and stays stored, so a column narrowed by a
// small panel widens back with the panel.

export const TREE_DEFAULT_WIDTH = 240;
export const TREE_MIN_WIDTH = 192;
const TREE_MAX_WIDTH = 560;
const DIFFS_MIN_WIDTH = 256;
/** How far an arrow key moves the column's edge. */
const TREE_WIDTH_STEP = 16;

/** The widest the column may be in a Code body this wide. */
export function treeMaxWidth(bodyWidth: number): number {
  return Math.max(TREE_MIN_WIDTH, Math.min(TREE_MAX_WIDTH, bodyWidth - DIFFS_MIN_WIDTH));
}

/** The width the column shows for a chosen one; one that is not a number shows the default. */
export function clampTreeWidth(width: number, maxWidth: number): number {
  const chosen = Number.isFinite(width) ? width : TREE_DEFAULT_WIDTH;
  return Math.max(TREE_MIN_WIDTH, Math.min(maxWidth, chosen));
}

/**
 * The width a key on the column's handle steps it to, or null for a key that does not: the arrow
 * toward the diffs widens it, the other narrows it, Home makes it the narrowest and End the widest.
 * The column sits at the inline start, so in a right-to-left layout the diffs are to its left.
 */
export function steppedTreeWidth(
  key: string,
  width: number,
  maxWidth: number,
  rightToLeft: boolean
): number | null {
  const towardDiffs = rightToLeft ? 'ArrowLeft' : 'ArrowRight';
  const awayFromDiffs = rightToLeft ? 'ArrowRight' : 'ArrowLeft';
  switch (key) {
    case towardDiffs:
      return clampTreeWidth(width + TREE_WIDTH_STEP, maxWidth);
    case awayFromDiffs:
      return clampTreeWidth(width - TREE_WIDTH_STEP, maxWidth);
    case 'Home':
      return TREE_MIN_WIDTH;
    case 'End':
      return maxWidth;
    default:
      return null;
  }
}
