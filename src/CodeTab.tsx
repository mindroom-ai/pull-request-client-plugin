// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab of the panel, laid out as T3 Code's pull request Code tab: the changed files as a
// tree beside their diffs, or above them in a narrow panel. Choosing a file in the tree scrolls
// its diff to the top.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { IconButton, IconTooltip, useThemeKind } from '@mindroom/client-sdk/ui';
import type { CodeViewDiffItem } from '@pierre/diffs';
import type { CodeViewHandle } from '@pierre/diffs/react';
import type { GitStatus } from '@pierre/trees';
import { FolderTree } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { DiffFileTree, type DiffFileTreeEntry } from './diff/DiffFileTree';
import { orderDiffFilesLikeTree } from './diff/diffFileTree.logic';
import { DIFF_THEME_NAMES, getRenderablePatch, resolveFileDiffPath } from './diff/diffRendering';
import { StyledDiffCodeView } from './diff/StyledDiffCodeView';
import { filePatch, type PullRequestFile, type PullRequestRef } from './github';
import { PullRequestMetaLine } from './presentation';
import { pluginRootStyle } from './theme';

function treeStatus(status: PullRequestFile['status']): GitStatus {
  if (status === 'removed') return 'deleted';
  if (status === 'renamed' || status === 'copied') return 'renamed';
  if (status === 'added') return 'added';
  return 'modified';
}

export function CodeTab({
  pullRequest,
  files,
}: {
  pullRequest: PullRequestRef;
  files: PullRequestFile[];
}) {
  const t = usePluginTranslation('pull-requests');
  const themeKind = useThemeKind();
  const [treeOpen, setTreeOpen] = useState(true);
  const viewerRef = useRef<CodeViewHandle<undefined, undefined>>(null);
  const rowsRef = useRef(new Map<string, HTMLElement>());

  // The highlighted lines depend on the theme, so the parse that caches them carries it in its key.
  const scope = `pull-request:${pullRequest.owner}/${pullRequest.repo}#${pullRequest.number}:${themeKind}`;
  const items = useMemo((): CodeViewDiffItem[] => {
    const patch = files
      .map(filePatch)
      .filter((part): part is string => part !== null)
      .join('');
    const parsed = getRenderablePatch(patch, scope);
    const parsedFiles = parsed?.kind === 'files' ? orderDiffFilesLikeTree(parsed.files) : [];
    return parsedFiles.map((fileDiff) => ({
      id: resolveFileDiffPath(fileDiff),
      type: 'diff',
      fileDiff,
    }));
  }, [files, scope]);
  // A file without a diff to show, as GitHub sends none for a binary or a very large file.
  const withoutDiff = useMemo(() => {
    const shown = new Set(items.map((item) => item.id));
    return files.filter((file) => !shown.has(file.path));
  }, [files, items]);
  const entries = useMemo(
    (): DiffFileTreeEntry[] =>
      files.map((file) => ({ path: file.path, status: treeStatus(file.status) })),
    [files]
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
        <PullRequestMetaLine>
          <span>{t('code.fileCount', { count: files.length })}</span>
        </PullRequestMetaLine>
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
          <StyledDiffCodeView<undefined>
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
          />
        </div>
      </div>
    </div>
  );
}
