// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestChangeBreakdownStat.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The header's `+/-` stat, with a popover that splits the lines into code, tests, generated files
// and docs. The files load on first focus or hover unless the Code tab already has them.
import { useEffect, useId, useRef, useState } from 'react';
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
  const tooltipId = useId();
  const statRef = useRef<HTMLButtonElement>(null);
  const wasOpenOnPress = useRef<boolean | undefined>(undefined);
  const [requested, setRequested] = useState(false);
  const [anchor, setAnchor] = useState<RectCords>();
  // Files the Code tab loaded already are in the cache, so a disabled query still has them.
  const query = usePullRequestFiles(pullRequestRef, requested);
  const isOpen = !!anchor && !query.isError;
  useEffect(() => {
    const stat = statRef.current;
    if (!isOpen || !stat) return undefined;
    const doc = stat.ownerDocument;
    // On iOS a tap need not focus the stat, so a tap elsewhere need not blur it either.
    const onPointerDown = (event: PointerEvent) => {
      if (!stat.contains(event.target as Node | null)) setAnchor(undefined);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      // Leave focus on the stat instead of letting the room shortcut move it to the composer.
      if (doc.activeElement === stat) event.preventDefault();
      setAnchor(undefined);
    };
    doc.addEventListener('pointerdown', onPointerDown, true);
    doc.addEventListener('keydown', onKeyDown);
    return () => {
      doc.removeEventListener('pointerdown', onPointerDown, true);
      doc.removeEventListener('keydown', onKeyDown);
    };
  }, [isOpen]);
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
        ref={statRef}
        type="button"
        className="mrpr-stat-button"
        aria-label={label}
        aria-describedby={tooltipId}
        onFocus={(event) => open(event.currentTarget)}
        onBlur={() => setAnchor(undefined)}
        onPointerEnter={(event) => {
          if (event.pointerType === 'mouse') open(event.currentTarget);
        }}
        onPointerLeave={(event) => {
          if (event.pointerType === 'mouse') setAnchor(undefined);
        }}
        onPointerDown={(event) => {
          // A mouse click keeps the hover tip open. Other pointers toggle the state before focus.
          wasOpenOnPress.current = event.pointerType === 'mouse' ? false : isOpen;
        }}
        onClick={(event) => {
          const wasOpen = event.detail ? (wasOpenOnPress.current ?? isOpen) : isOpen;
          wasOpenOnPress.current = undefined;
          if (wasOpen) setAnchor(undefined);
          else open(event.currentTarget);
        }}
      >
        <PullRequestDiffStat additions={additions} deletions={deletions} />
      </button>
      {query.isError ? null : (
        // folds' PopOut layer covers the window. A tooltip lets the pointer through it, as the app's
        // TipButton does: else the layer takes the pointer from the stat, whose pointer leave closes
        // the tooltip, and the next move opens it again, over and over.
        <PopOut
          style={{ pointerEvents: 'none' }}
          anchor={anchor}
          position="Bottom"
          align="End"
          offset={4}
          content={
            // The host moves focus into dialogs. This read-only tooltip must leave it on the stat,
            // whose blur would otherwise remove the popover and send focus back to the stat.
            <Menu id={tooltipId} role="tooltip">
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
