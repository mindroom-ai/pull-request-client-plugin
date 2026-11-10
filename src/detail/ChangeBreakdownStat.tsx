// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestChangeBreakdownStat.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The header's `+/-` stat, with a popover that splits the lines into code, tests, generated files
// and docs. The files load on first focus or hover unless the Code tab already has them.
import { useState } from 'react';
import type { RectCords } from 'folds';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { Menu, PopOut } from '@mindroom/client-sdk/ui';
import { changedFileKind, type ChangedFileKind } from '../diff/changedFileKind';
import type { PullRequestFile, PullRequestRef } from '../github';
import { PullRequestDiffStat } from '../presentation';
import { usePullRequestFiles } from '../queries';
import { pluginRootStyle } from '../theme';

const KINDS: readonly ChangedFileKind[] = ['code', 'test', 'generated', 'docs'];

type Lines = { additions: number; deletions: number };

/** The added and deleted lines of the files, summed by the kind their path says they are. */
export function changeBreakdown(files: PullRequestFile[]): Record<ChangedFileKind, Lines> {
  const breakdown: Record<ChangedFileKind, Lines> = {
    code: { additions: 0, deletions: 0 },
    test: { additions: 0, deletions: 0 },
    generated: { additions: 0, deletions: 0 },
    docs: { additions: 0, deletions: 0 },
  };
  for (const file of files) {
    const lines = breakdown[changedFileKind(file.path)];
    lines.additions += file.additions;
    lines.deletions += file.deletions;
  }
  return breakdown;
}

export function ChangeBreakdownStat({
  pullRequestRef,
  additions,
  deletions,
}: {
  pullRequestRef: PullRequestRef;
  additions: number;
  deletions: number;
}) {
  const t = usePluginTranslation('pull-requests');
  const [requested, setRequested] = useState(false);
  const [anchor, setAnchor] = useState<RectCords>();
  // Files the Code tab loaded already are in the cache, so a disabled query still has them.
  const query = usePullRequestFiles(pullRequestRef, requested);
  if (additions === 0 && deletions === 0) return null;
  const open = (element: HTMLElement) => {
    setRequested(true);
    setAnchor(element.getBoundingClientRect());
  };
  const rows = query.data ? changeBreakdown(query.data) : undefined;
  const label = t('breakdown.label', { additions, deletions });
  return (
    <>
      <button
        type="button"
        className="mrpr-stat-button"
        aria-label={label}
        aria-haspopup="dialog"
        aria-expanded={anchor !== undefined && !query.isError}
        onFocus={(event) => open(event.currentTarget)}
        onBlur={() => setAnchor(undefined)}
        onPointerEnter={(event) => open(event.currentTarget)}
        onPointerLeave={() => setAnchor(undefined)}
        onClick={(event) => open(event.currentTarget)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') setAnchor(undefined);
        }}
      >
        <PullRequestDiffStat additions={additions} deletions={deletions} />
      </button>
      {query.isError ? null : (
        <PopOut
          anchor={anchor}
          position="Bottom"
          align="End"
          offset={4}
          content={
            <Menu role="dialog" aria-label={label}>
              <div className="mrpr-root mrpr-popover mrpr-popover-fit" style={pluginRootStyle()}>
                {rows ? (
                  <div className="mrpr-breakdown">
                    {KINDS.flatMap((kind) => {
                      const lines = rows[kind];
                      return lines.additions === 0 && lines.deletions === 0
                        ? []
                        : [<Row key={kind} label={t(`breakdown.${kind}`)} lines={lines} />];
                    })}
                    <div className="mrpr-breakdown-rule" />
                    <Row label={t('breakdown.total')} lines={{ additions, deletions }} />
                  </div>
                ) : (
                  <p className="mrpr-popover-line">{t('breakdown.loading')}</p>
                )}
              </div>
            </Menu>
          }
        />
      )}
    </>
  );
}

function Row({ label, lines }: { label: string; lines: Lines }) {
  return (
    <>
      <span>{label}</span>
      <span className="mrpr-added">+{lines.additions.toLocaleString()}</span>
      <span className="mrpr-removed">-{lines.deletions.toLocaleString()}</span>
    </>
  );
}
