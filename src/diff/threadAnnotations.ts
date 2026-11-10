// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/pullRequestDiff.logic.ts and PullRequestCodeTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// Where the Code tab shows a review thread: at its line in a rendered hunk, as an annotation of
// Pierre's diff view, else in the list of conversations not on the current diff.
import type { DiffLineAnnotation, FileDiffMetadata } from '@pierre/diffs';
import type { ReviewThread } from '../reviewThreads';
import { resolveFileDiffPath } from './diffRendering';

/** What one annotation carries: the threads on its side and line, in the order they came. */
export type ThreadGroup = { threads: ReviewThread[] };

export type ThreadAnnotation = DiffLineAnnotation<ThreadGroup>;

/** Only rendered hunks can anchor comments; list others off-diff. */
export function isLineInFileDiff(
  file: FileDiffMetadata,
  side: ReviewThread['side'],
  line: number
): boolean {
  return file.hunks.some((hunk) =>
    side === 'LEFT'
      ? line >= hunk.deletionStart && line < hunk.deletionStart + hunk.deletionCount
      : line >= hunk.additionStart && line < hunk.additionStart + hunk.additionCount
  );
}

export function toViewerSide(side: ReviewThread['side']) {
  return side === 'LEFT' ? ('deletions' as const) : ('additions' as const);
}

export type PlacedThreads = {
  /** The annotations of each file that has any, by its path. */
  annotations: ReadonlyMap<string, ThreadAnnotation[]>;
  /** The threads no rendered line holds, in the order they came. */
  offDiff: ReviewThread[];
};

/**
 * The threads on a rendered line of the files, one annotation for each side and line, and the
 * rest: an outdated thread (its line is the one it had on its own commit), one whose line is in no
 * hunk, one on a file the view does not show, and on a single commit's view, whose lines are that
 * commit's rather than the pull request's, every thread.
 */
export function placeThreads(
  files: readonly FileDiffMetadata[],
  threads: readonly ReviewThread[],
  commitView: boolean
): PlacedThreads {
  const filesByPath = new Map(files.map((file) => [resolveFileDiffPath(file), file]));
  const groups = new Map<string, Map<string, ThreadAnnotation>>();
  const offDiff: ReviewThread[] = [];
  for (const thread of threads) {
    const file = commitView ? undefined : filesByPath.get(thread.path);
    const line = thread.outdated ? null : thread.line;
    if (!file || line === null || !isLineInFileDiff(file, thread.side, line)) {
      offDiff.push(thread);
      continue;
    }
    let fileGroups = groups.get(thread.path);
    if (!fileGroups) groups.set(thread.path, (fileGroups = new Map()));
    const key = `${thread.side}:${line}`;
    const group = fileGroups.get(key);
    if (group) group.metadata.threads.push(thread);
    else {
      fileGroups.set(key, {
        side: toViewerSide(thread.side),
        lineNumber: line,
        metadata: { threads: [thread] },
      });
    }
  }
  return {
    annotations: new Map([...groups].map(([path, fileGroups]) => [path, [...fileGroups.values()]])),
    offDiff,
  };
}

/**
 * Everything a file's annotations show, as one string. Pierre's view draws an item again only
 * when its version changes, so the version is made from this.
 */
export function annotationsKey(annotations: readonly ThreadAnnotation[]): string {
  return annotations
    .map(
      ({ side, lineNumber, metadata }) =>
        `${side}:${lineNumber}:${metadata.threads
          .map(
            (thread) =>
              `${thread.id}:${thread.comments
                .map(
                  (comment) =>
                    `${comment.id}:${comment.author?.login ?? ''}:${comment.createdAt}:${
                      comment.body
                    }:${comment.reactions
                      .map((reaction) => `${reaction.content}:${reaction.count}`)
                      .join(',')}`
                )
                .join(';')}`
          )
          .join(',')}`
    )
    .join('|');
}
