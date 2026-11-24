// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/lib/diffRendering.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Patch parsing, whitespace hiding and the diff surface's theme, the part of T3 Code's diff
// rendering the Code tab uses.
import { parseDiffFromFile, parsePatchFiles, type FileDiffMetadata } from '@pierre/diffs';
import { GIT_LFS_POINTER_HEADER, MAX_DIFF_BLOB_BYTES, type DiffSource } from './diffSource';

export const DIFF_THEME_NAMES = {
  light: 'pierre-light',
  dark: 'pierre-dark',
} as const;

const FNV_OFFSET_BASIS_32 = 0x811c9dc5;
const FNV_PRIME_32 = 0x01000193;
const SECONDARY_HASH_SEED = 0x9e3779b9;
const SECONDARY_HASH_MULTIPLIER = 0x85ebca6b;

export function fnv1a32(
  input: string,
  seed = FNV_OFFSET_BASIS_32,
  multiplier = FNV_PRIME_32
): number {
  let hash = seed >>> 0;
  for (let index = 0; index < input.length; index += 1) {
    hash ^= input.charCodeAt(index);
    hash = Math.imul(hash, multiplier) >>> 0;
  }
  return hash >>> 0;
}

function buildPatchCacheKey(patch: string, scope = 'diff-panel'): string {
  const primary = fnv1a32(patch, FNV_OFFSET_BASIS_32, FNV_PRIME_32).toString(36);
  const secondary = fnv1a32(patch, SECONDARY_HASH_SEED, SECONDARY_HASH_MULTIPLIER).toString(36);
  return `${scope}:${patch.length}:${primary}:${secondary}`;
}

export type RenderablePatch =
  | {
      kind: 'files';
      files: FileDiffMetadata[];
    }
  | {
      kind: 'raw';
      text: string;
      reason: string;
    };

export interface DiffLineStat {
  additions: number;
  deletions: number;
}

export function getDiffLineStat(files: ReadonlyArray<FileDiffMetadata>): DiffLineStat {
  return files.reduce<DiffLineStat>(
    (total, file) => {
      for (const hunk of file.hunks) {
        total.additions += hunk.additionLines;
        total.deletions += hunk.deletionLines;
      }

      return total;
    },
    { additions: 0, deletions: 0 }
  );
}

export function canHydrateDiff(file: FileDiffMetadata): boolean {
  return (
    file.isPartial &&
    file.hunks.length > 0 &&
    (file.type === 'change' || file.type === 'rename-changed')
  );
}

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/;
const NO_NEWLINE = '\\ No newline at end of file';

/** Reverse a complete GitHub patch against its own new blob. Never trust Pierre's repaired counts. */
export function reconstructOldFile(
  file: FileDiffMetadata,
  source: DiffSource,
  blob: string
): string | null {
  const rawHunks = source.patch?.split(/(?=^@@ )/m);
  if (!rawHunks || file.hunks.length === 0 || rawHunks.length !== file.hunks.length) return null;
  const lines = blob === '' ? [] : blob.split(/(?<=\n)/);
  const old: string[] = [];
  let oldEnd = 0;
  let newEnd = 0;
  let additions = 0;
  let deletions = 0;
  let oldEOF = false;
  let newEOF = false;

  for (const [index, raw] of rawHunks.entries()) {
    const [header = '', ...rows] = raw.split('\n');
    if (rows.at(-1) === '') rows.pop();
    const match = HUNK_HEADER.exec(header);
    if (!match) return null;
    const oldAt = Number(match[1]);
    const oldCount = Number(match[2] ?? 1);
    const newAt = Number(match[3]);
    const newCount = Number(match[4] ?? 1);
    const hunk = file.hunks[index]!;
    if (
      ![oldAt, oldCount, newAt, newCount].every(Number.isSafeInteger) ||
      oldAt !== hunk.deletionStart ||
      oldCount !== hunk.deletionCount ||
      newAt !== hunk.additionStart ||
      newCount !== hunk.additionCount
    )
      return null;

    // With no lines on a side, the header names the line before the change.
    const oldStart = oldAt - (oldCount === 0 ? 0 : 1);
    const newStart = newAt - (newCount === 0 ? 0 : 1);
    const gap = newStart - newEnd;
    if (
      gap < 0 ||
      gap !== oldStart - oldEnd ||
      newStart + newCount > lines.length ||
      (oldEOF && gap + oldCount > 0) ||
      (newEOF && gap + newCount > 0)
    )
      return null;
    if (gap > 0 && !lines[newStart - 1]?.endsWith('\n')) oldEOF = true;
    if (oldEOF && oldCount > 0) return null;
    old.push(lines.slice(newEnd, newStart).join(''));

    let oldRows = 0;
    let newRows = 0;
    let oldMarker = false;
    let newMarker = false;
    for (let row = 0; row < rows.length; row += 1) {
      const line = rows[row]!;
      const sign = line[0];
      if (sign !== ' ' && sign !== '+' && sign !== '-') return null;
      const hasMarker = rows[row + 1] === NO_NEWLINE;
      const text = line.slice(1) + (hasMarker ? '' : '\n');
      if (sign !== '+') {
        if (
          oldEOF ||
          oldRows >= oldCount ||
          text === '' ||
          text.includes('\0') ||
          file.deletionLines[hunk.deletionLineIndex + oldRows] !== text
        )
          return null;
        old.push(text);
        oldRows += 1;
        oldMarker = oldEOF = hasMarker;
      }
      if (sign !== '-') {
        if (
          newEOF ||
          newRows >= newCount ||
          lines[newStart + newRows] !== text ||
          file.additionLines[hunk.additionLineIndex + newRows] !== text
        )
          return null;
        newRows += 1;
        newMarker = newEOF = hasMarker;
      }
      if (sign === '+') additions += 1;
      if (sign === '-') deletions += 1;
      if (hasMarker) row += 1;
    }
    if (
      oldRows !== oldCount ||
      newRows !== newCount ||
      oldMarker !== hunk.noEOFCRDeletions ||
      newMarker !== hunk.noEOFCRAdditions
    )
      return null;
    oldEnd = oldStart + oldCount;
    newEnd = newStart + newCount;
  }

  if (
    additions !== source.additions ||
    deletions !== source.deletions ||
    ((oldEOF || newEOF) && newEnd !== lines.length)
  )
    return null;
  old.push(lines.slice(newEnd).join(''));
  const contents = old.join('');
  // Lines only present in the old patch are not covered by the new blob's checks.
  if (contents.startsWith(GIT_LFS_POINTER_HEADER)) return null;
  return new TextEncoder().encode(contents).length <= MAX_DIFF_BLOB_BYTES ? contents : null;
}

export function prepareFileDiff(
  file: FileDiffMetadata,
  { ignoreWhitespace = false, sha }: { ignoreWhitespace?: boolean; sha?: string | null } = {}
): FileDiffMetadata {
  // Hand Pierre a fresh object: on-demand `loadDiffFiles` replaces top-level fields in place.
  const cacheKey = file.cacheKey && sha ? `${file.cacheKey}:${sha}` : file.cacheKey;
  const copy = cacheKey === file.cacheKey ? { ...file } : { ...file, cacheKey };
  if (!ignoreWhitespace) return copy;
  try {
    return hideWhitespaceChanges(copy);
  } catch {
    // If filtering fails, show the unfiltered diff.
    return copy;
  }
}

function hideWhitespaceChanges(file: FileDiffMetadata): FileDiffMetadata {
  let splitDelta = 0;
  let unifiedDelta = 0;
  const hunks = file.hunks.map((hunk) => {
    const oldContents = file.deletionLines
      .slice(hunk.deletionLineIndex, hunk.deletionLineIndex + hunk.deletionCount)
      .map((line) => `${line.replace(/\s/g, '')}\n`)
      .join('');
    const newContents = file.additionLines
      .slice(hunk.additionLineIndex, hunk.additionLineIndex + hunk.additionCount)
      .map((line) => `${line.replace(/\s/g, '')}\n`)
      .join('');
    const filtered = parseDiffFromFile(
      { name: file.name, contents: oldContents },
      { name: file.name, contents: newContents },
      { context: Infinity }
    ).hunks[0];
    const next = {
      ...hunk,
      additionLines: filtered?.additionLines ?? 0,
      deletionLines: filtered?.deletionLines ?? 0,
      hunkContent: filtered
        ? filtered.hunkContent.map((content) => ({
            ...content,
            additionLineIndex: content.additionLineIndex + hunk.additionLineIndex,
            deletionLineIndex: content.deletionLineIndex + hunk.deletionLineIndex,
          }))
        : [
            {
              type: 'context' as const,
              lines: hunk.additionCount,
              additionLineIndex: hunk.additionLineIndex,
              deletionLineIndex: hunk.deletionLineIndex,
            },
          ],
      splitLineStart: hunk.splitLineStart + splitDelta,
      unifiedLineStart: hunk.unifiedLineStart + unifiedDelta,
      splitLineCount: filtered?.splitLineCount ?? hunk.additionCount,
      unifiedLineCount: filtered?.unifiedLineCount ?? hunk.additionCount,
    };
    splitDelta += next.splitLineCount - hunk.splitLineCount;
    unifiedDelta += next.unifiedLineCount - hunk.unifiedLineCount;
    return next;
  });
  return {
    ...file,
    hunks,
    splitLineCount: file.splitLineCount + splitDelta,
    unifiedLineCount: file.unifiedLineCount + unifiedDelta,
    ...(file.cacheKey ? { cacheKey: `${file.cacheKey}:ignore-whitespace` } : {}),
  };
}

export function getRenderablePatch(
  patch: string | undefined,
  cacheScope = 'diff-panel'
): RenderablePatch | null {
  if (!patch?.trim()) return null;

  try {
    const parsedPatches = parsePatchFiles(patch, {
      cacheKeyPrefix: buildPatchCacheKey(patch, cacheScope),
    });
    const files = parsedPatches.flatMap((parsedPatch) => parsedPatch.files);
    if (files.length > 0) {
      return { kind: 'files', files };
    }

    return {
      kind: 'raw',
      text: patch,
      reason: 'Unsupported diff format. Showing raw patch.',
    };
  } catch {
    return {
      kind: 'raw',
      text: patch,
      reason: 'Failed to parse patch. Showing raw patch.',
    };
  }
}

/** Uses the parser-decoded filename, including Git's quoted and escaped names. */
export function resolveFileDiffPath(fileDiff: FileDiffMetadata): string {
  return fileDiff.name ?? fileDiff.prevName ?? '';
}

export const DIFF_SURFACE_THEME_UNSAFE_CSS = `
[data-diffs-header],
[data-diff],
[data-file],
[data-error-wrapper],
[data-virtualizer-buffer] {
  --diffs-header-font-family: var(--font-sans) !important;
  --diffs-font-family: var(--font-mono) !important;
  --diffs-bg: var(--code-background) !important;
  --diffs-light-bg: var(--code-background) !important;
  --diffs-dark-bg: var(--code-background) !important;
  --diffs-token-light-bg: transparent;
  --diffs-token-dark-bg: transparent;

  /* Gutter, context, and row tints all derive from the code surface the diff
     body sits on. Mixing from the canvas leaves the gutter looking unthemed
     when a palette separates the two. */
  --diffs-bg-context-override: color-mix(in srgb, var(--code-background) 97%, var(--code-foreground));
  --diffs-bg-hover-override: color-mix(in srgb, var(--code-background) 94%, var(--code-foreground));
  --diffs-bg-separator-override: color-mix(
    in srgb,
    var(--code-background) 95%,
    var(--code-foreground)
  );
  --diffs-bg-buffer-override: color-mix(in srgb, var(--code-background) 90%, var(--code-foreground));

  --diffs-bg-addition-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--diff-addition)),
    color-mix(in srgb, var(--code-background) 70%, var(--diff-addition))
  );
  --diffs-bg-addition-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--diff-addition)),
    color-mix(in srgb, var(--code-background) 60%, var(--diff-addition))
  );
  --diffs-bg-addition-hover-override: color-mix(in srgb, var(--code-background) 85%, var(--diff-addition));
  --diffs-bg-addition-emphasis-override: color-mix(
    in srgb,
    var(--code-background) 80%,
    var(--diff-addition)
  );

  --diffs-bg-deletion-override: light-dark(
    color-mix(in srgb, var(--code-background) 50%, var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) 70%, var(--diff-deletion))
  );
  --diffs-bg-deletion-number-override: light-dark(
    color-mix(in srgb, var(--code-background) 35%, var(--diff-deletion)),
    color-mix(in srgb, var(--code-background) 60%, var(--diff-deletion))
  );
  --diffs-bg-deletion-hover-override: color-mix(
    in srgb,
    var(--code-background) 85%,
    var(--diff-deletion)
  );
  --diffs-bg-deletion-emphasis-override: color-mix(
    in srgb,
    var(--code-background) 80%,
    var(--diff-deletion)
  );

  background-color: var(--diffs-bg) !important;
  color: var(--code-foreground) !important;
}

/* The library's change-icon colors are tuned for dark canvases; light mode takes the app's darker tokens. */
[data-change-icon="new"] {
  color: var(
    --diff-added-icon,
    light-dark(var(--diff-addition-foreground), var(--diffs-addition-base))
  ) !important;
}
[data-change-icon="deleted"] {
  color: light-dark(var(--diff-deletion-foreground), var(--diffs-deletion-base)) !important;
}
[data-change-icon="change"],
[data-change-icon="rename-pure"],
[data-change-icon="rename-changed"] {
  color: var(
    --diff-modified-icon,
    light-dark(var(--info-foreground), var(--diffs-modified-base))
  ) !important;
}
`;
