// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab of the panel, laid out as T3 Code's pull request Code tab: the changed files as a
// tree beside their diffs, or above them in a narrow panel. Choosing a file in the tree scrolls
// its diff to the top. Review threads show at their lines in the diffs, and the ones no rendered
// line holds in a bar above them; the commit selector shows one commit's diff in place of the
// pull request's.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { IconButton, IconTooltip, useThemeKind } from '@mindroom/client-sdk/ui';
import type { CodeViewDiffItem } from '@pierre/diffs';
import type { CodeViewAnnotationArgs, CodeViewHandle } from '@pierre/diffs/react';
import type { GitStatus } from '@pierre/trees';
import { FolderTree } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { CommitSelector } from './detail/CommitSelector';
import { OffDiffThreads } from './detail/OffDiffThreads';
import { ReviewThreadCard } from './detail/ReviewThreadCard';
import { DiffFileTree, type DiffFileTreeEntry } from './diff/DiffFileTree';
import { orderDiffFilesLikeTree } from './diff/diffFileTree.logic';
import {
  DIFF_THEME_NAMES,
  fnv1a32,
  getRenderablePatch,
  resolveFileDiffPath,
} from './diff/diffRendering';
import { StyledDiffCodeView } from './diff/StyledDiffCodeView';
import { annotationsKey, placeThreads, type ThreadGroup } from './diff/threadAnnotations';
import { filePatch, type Commit, type PullRequestFile, type PullRequestRef } from './github';
import { GitHubErrorState } from './GitHubErrorState';
import { PullRequestMetaLine } from './presentation';
import { useCommitFiles } from './queries';
import type { ReviewThread } from './reviewThreads';
import { pluginRootStyle } from './theme';

/** A list the panel loads for the tab: its items once they have loaded, else why they did not. */
export type ListState<T> =
  | { status: 'pending' }
  | { status: 'error'; error: unknown; retry: () => void }
  | { status: 'success'; items: T[] };

const NO_THREADS: ReviewThread[] = [];

function treeStatus(status: PullRequestFile['status']): GitStatus {
  if (status === 'removed') return 'deleted';
  if (status === 'renamed' || status === 'copied') return 'renamed';
  if (status === 'added') return 'added';
  return 'modified';
}

// The threads on one line of a diff, one card each.
const renderAnnotation = (...[annotation]: CodeViewAnnotationArgs<ThreadGroup>) => (
  <div className="mrpr-annotation">
    {annotation.metadata.threads.map((thread) => (
      <ReviewThreadCard key={thread.id} thread={thread} />
    ))}
  </div>
);

export function CodeTab({
  pullRequest,
  files,
  threads,
  commits,
  commit,
  onCommitChange,
}: {
  pullRequest: PullRequestRef;
  /** The files of the pull request as a whole. */
  files: PullRequestFile[];
  threads: ListState<ReviewThread>;
  commits: ListState<Commit>;
  /** The SHA of the commit whose diff shows; undefined is All commits. */
  commit: string | undefined;
  onCommitChange: (sha: string | undefined) => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const themeKind = useThemeKind();
  const [treeOpen, setTreeOpen] = useState(true);
  const viewerRef = useRef<CodeViewHandle<ThreadGroup, undefined>>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());

  // A commit opened from the Timeline or left chosen across a force-push may no longer be part of
  // the pull request; it reads as All commits then, and its files are not asked for.
  const shownCommit =
    commit !== undefined &&
    commits.status === 'success' &&
    commits.items.some((entry) => entry.sha === commit)
      ? commit
      : undefined;
  const commitFiles = useCommitFiles(pullRequest, shownCommit ?? '', shownCommit !== undefined);
  const viewFiles = shownCommit === undefined ? files : commitFiles.data;

  // The highlighted lines depend on the theme, so the parse that caches them carries it in its key.
  const scope = `pull-request:${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}:${themeKind}`;
  const parsedFiles = useMemo(() => {
    const patch = (viewFiles ?? [])
      .map(filePatch)
      .filter((part): part is string => part !== null)
      .join('');
    const parsed = getRenderablePatch(patch, scope);
    return parsed?.kind === 'files' ? orderDiffFilesLikeTree(parsed.files) : [];
  }, [viewFiles, scope]);
  const threadList = threads.status === 'success' ? threads.items : NO_THREADS;
  const placed = useMemo(
    () => placeThreads(parsedFiles, threadList, shownCommit !== undefined),
    [parsedFiles, threadList, shownCommit]
  );
  const items = useMemo(
    (): CodeViewDiffItem<ThreadGroup>[] =>
      parsedFiles.map((fileDiff) => {
        const annotations = placed.annotations.get(resolveFileDiffPath(fileDiff)) ?? [];
        return {
          id: resolveFileDiffPath(fileDiff),
          type: 'diff',
          fileDiff,
          annotations,
          // Pierre's view redraws an item it has drawn only when the item's version changes, so
          // the version follows the diff (a commit's diff of a path is another) and its threads.
          version: fnv1a32(`${fileDiff.cacheKey ?? ''}|${annotationsKey(annotations)}`),
        };
      }),
    [parsedFiles, placed]
  );
  // A file without a diff to show, as GitHub sends none for a binary or a very large file.
  const withoutDiff = useMemo(() => {
    const shown = new Set(items.map((item) => item.id));
    return (viewFiles ?? []).filter((file) => !shown.has(file.path));
  }, [viewFiles, items]);
  const entries = useMemo(
    (): DiffFileTreeEntry[] =>
      (viewFiles ?? []).map((file) => ({ path: file.path, status: treeStatus(file.status) })),
    [viewFiles]
  );

  const reveal = (path: string) => {
    if (items.some((item) => item.id === path)) {
      viewerRef.current?.scrollTo({ type: 'item', id: path, align: 'start' });
    } else {
      rowsRef.current.get(path)?.scrollIntoView({ block: 'nearest' });
    }
  };

  const renderWithoutDiff = () =>
    withoutDiff.length === 0 ? null : (
      <ul className="mrpr-no-diff-list">
        {withoutDiff.map((file) => (
          <li
            key={file.path}
            className="mrpr-no-diff"
            ref={(row) => {
              if (row) rowsRef.current.set(file.path, row);
              else rowsRef.current.delete(file.path);
            }}
          >
            <span className="mrpr-no-diff-path">{file.path}</span>
            <span className="mrpr-meta">
              <span>{t('noDiff')}</span>
              <a href={file.url} target="_blank" rel="noopener noreferrer" className="mrpr-link">
                {t('openOnGitHub')}
              </a>
            </span>
          </li>
        ))}
      </ul>
    );

  return (
    <div className="mrpr-root mrpr-code" style={pluginRootStyle()}>
      <div className="mrpr-code-toolbar">
        <div className="mrpr-code-toolbar-start">
          {commits.status === 'success' && commits.items.length > 0 ? (
            <CommitSelector
              commits={commits.items}
              commit={shownCommit}
              onCommitChange={onCommitChange}
            />
          ) : null}
          {viewFiles ? (
            <PullRequestMetaLine>
              <span>{t('code.fileCount', { count: viewFiles.length })}</span>
            </PullRequestMetaLine>
          ) : null}
        </div>
        <IconTooltip label={t('code.files')} align="End">
          {(triggerRef) => (
            <IconButton
              ref={triggerRef}
              size="300"
              radii="300"
              aria-label={t('code.files')}
              aria-pressed={treeOpen}
              onClick={() => setTreeOpen((open) => !open)}
            >
              <FolderTree aria-hidden className="mrpr-button-icon" />
            </IconButton>
          )}
        </IconTooltip>
      </div>
      {/* A list that did not load leaves the diffs whole; it says so, with a retry, above them. */}
      {commits.status === 'error' || threads.status === 'error' ? (
        <div className="mrpr-code-notices">
          {commits.status === 'error' ? (
            <GitHubErrorState error={commits.error} onRetry={commits.retry} />
          ) : null}
          {threads.status === 'error' ? (
            <GitHubErrorState error={threads.error} onRetry={threads.retry} />
          ) : null}
        </div>
      ) : null}
      {/* Another view starts with the bar closed. */}
      <OffDiffThreads key={shownCommit ?? ''} threads={placed.offDiff} />
      {viewFiles ? (
        <div className="mrpr-code-body">
          {treeOpen ? (
            <div className="mrpr-code-tree">
              <DiffFileTree
                ariaLabel={t('code.treeLabel', pullRequest)}
                entries={entries}
                onSelectFile={reveal}
              />
            </div>
          ) : null}
          <div className="mrpr-code-diffs">
            {/* The viewer must own its scroll element to position virtual rows within it. */}
            <StyledDiffCodeView<ThreadGroup>
              viewerRef={viewerRef}
              items={items}
              options={{
                theme: DIFF_THEME_NAMES[themeKind],
                themeType: themeKind,
                diffStyle: 'unified',
                overflow: 'wrap',
                lineDiffType: 'none',
                stickyHeaders: true,
              }}
              renderCodeViewFooter={renderWithoutDiff}
              renderAnnotation={renderAnnotation}
            />
          </div>
        </div>
      ) : (
        <div className="mrpr-panel-note">
          {commitFiles.isError ? (
            <GitHubErrorState
              error={commitFiles.error}
              onRetry={() => void commitFiles.refetch()}
            />
          ) : (
            <p className="mrpr-status">{t('loadingFiles')}</p>
          )}
        </div>
      )}
    </div>
  );
}
