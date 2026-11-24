// Dynamic-depth SVG Icicle flamegraph for Line Distribution: responsive page-zoomed viewBox,
// hover/focus inspect summary, opaque kind fills, and keyboard-accessible interactive nodes.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useRootFontSize } from '../rootFontSize';
import {
  ICICLE_DEFAULT_WIDTH,
  ICICLE_MAX_DEPTH,
  ICICLE_ROW_HEIGHT,
  buildIcicleTree,
  formatShare,
  layoutIcicle,
  type DistributionViewProps,
} from './lineDistribution.logic';

const truncateLabel = (text: string, width: number, padX: number, charWidth: number): string => {
  const maxChars = Math.max(3, Math.floor((width - padX * 2) / charWidth));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
};

export function DistributionIcicle(props: DistributionViewProps) {
  const { scopedFiles, dirPrefix, metric, scopeTotal, fmt, onDirPrefixChange, onSelectFile } =
    props;
  const t = usePluginTranslation('pull-requests');
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(ICICLE_DEFAULT_WIDTH);
  const [inspectedState, setInspectedState] = useState<{ scope: string; path: string } | null>(
    null
  );
  const rootFontSize = useRootFontSize();
  const zoom = rootFontSize / 16;
  const rowHeight = Math.round(ICICLE_ROW_HEIGHT * zoom);
  const padX = 5 * zoom;
  const labelY = 17 * zoom;
  const subY = 32 * zoom;
  const charWidth = 6.6 * zoom;
  const minLabelWidth = 34 * zoom;
  const minSubWidth = 66 * zoom;

  useLayoutEffect(() => {
    const el = boxRef.current;
    if (!el) return undefined;
    const apply = (measured: number) => {
      if (measured > 0) setWidth(Math.max(240, Math.round(measured)));
    };
    apply(el.getBoundingClientRect().width || el.clientWidth);
    if (typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver((entries) => {
      const entry = entries?.[entries.length - 1];
      apply(entry?.contentRect.width ?? (el.getBoundingClientRect().width || el.clientWidth));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const tree = useMemo(
    () => buildIcicleTree(scopedFiles, dirPrefix, metric),
    [scopedFiles, dirPrefix, metric]
  );
  const { rects, height } = useMemo(
    () => layoutIcicle(tree, width, ICICLE_MAX_DEPTH, rowHeight),
    [tree, width, rowHeight]
  );
  const inspectedPath = inspectedState?.scope === dirPrefix ? inspectedState.path : null;
  const inspected =
    inspectedPath === null
      ? null
      : (rects.find((r) => r.node.path === inspectedPath)?.node ?? null);

  return (
    <>
      <div ref={boxRef} className="mrpr-dist-icicle-box" style={{ blockSize: `${height}px` }}>
        <svg
          className="mrpr-dist-icicle-svg"
          viewBox={`0 0 ${width} ${height}`}
          width="100%"
          height={height}
          role="group"
          aria-label={t('code.distribution.regionLabel')}
        >
          {rects.map(({ node, depth, x, y, width: w, height: h }) => {
            const isRoot = depth === 0;
            const interactive = !isRoot;
            const displayPath = node.path || t('code.distribution.allFiles');
            const displayName = node.name || t('code.distribution.allFiles');
            const share = formatShare(node.value, scopeTotal);
            const label = t('code.distribution.icicleNodeLabel', {
              path: displayPath,
              additions: fmt.format(node.additions),
              deletions: fmt.format(node.deletions),
              share,
              files: t('code.fileCount', { count: node.files }),
            });
            const activate = () => {
              if (node.file) onSelectFile(node.file.path);
              else onDirPrefixChange(node.path);
            };
            const clearInspect = () =>
              setInspectedState((cur) => (cur?.path === node.path ? null : cur));
            const labelClass = isRoot
              ? 'mrpr-dist-icicle-root-label'
              : node.file
                ? 'mrpr-dist-icicle-label is-file'
                : 'mrpr-dist-icicle-label';
            const subStat =
              metric === 'total' && node.additions === 0 && node.deletions > 0
                ? `${share} · -${fmt.format(node.deletions)}`
                : `${share} · +${fmt.format(node.additions)}`;
            const interactiveProps = interactive
              ? {
                  role: 'button' as const,
                  tabIndex: 0,
                  'aria-label': label,
                  onClick: activate,
                  onFocus: () => setInspectedState({ scope: dirPrefix, path: node.path }),
                  onBlur: clearInspect,
                  onKeyDown: (event: KeyboardEvent<SVGGElement>) => {
                    if (event.key === 'Enter' || event.key === ' ') {
                      event.preventDefault();
                      activate();
                    }
                  },
                }
              : {};
            return (
              <g
                key={`${depth}:${node.path}`}
                className={
                  interactive ? 'mrpr-dist-icicle-node is-interactive' : 'mrpr-dist-icicle-node'
                }
                onMouseEnter={() => setInspectedState({ scope: dirPrefix, path: node.path })}
                onMouseLeave={clearInspect}
                {...interactiveProps}
              >
                <title>{label}</title>
                <rect
                  className={isRoot ? 'mrpr-dist-icicle-root-rect' : 'mrpr-dist-icicle-rect'}
                  data-kind={isRoot ? undefined : node.dominantKind}
                  x={(x + 0.5).toFixed(1)}
                  y={(y + 0.5).toFixed(1)}
                  width={Math.max(1, w - 1).toFixed(1)}
                  height={(h - 1).toFixed(1)}
                  rx="2"
                  fillOpacity={isRoot ? undefined : 1}
                />
                {w > minLabelWidth ? (
                  <text
                    className={labelClass}
                    x={(x + padX).toFixed(1)}
                    y={(y + labelY).toFixed(1)}
                    textAnchor="start"
                  >
                    {truncateLabel(displayName, w, padX, charWidth)}
                  </text>
                ) : null}
                {w > minSubWidth ? (
                  <text
                    className={isRoot ? 'mrpr-dist-icicle-root-sub' : 'mrpr-dist-icicle-sub'}
                    x={(x + padX).toFixed(1)}
                    y={(y + subY).toFixed(1)}
                    textAnchor="start"
                  >
                    {subStat}
                  </text>
                ) : null}
              </g>
            );
          })}
        </svg>
      </div>

      <div className="mrpr-dist-foot">
        {inspected ? (
          <span className="mrpr-dist-icicle-inspect mrpr-tabular">
            <span className="mrpr-dist-icicle-inspect-path">
              {inspected.path || t('code.distribution.allFiles')}
            </span>
            <span className="mrpr-added">+{fmt.format(inspected.additions)}</span>
            {metric === 'total' && inspected.deletions > 0 ? (
              <span className="mrpr-removed">-{fmt.format(inspected.deletions)}</span>
            ) : null}
            <span>{formatShare(inspected.value, scopeTotal)}</span>
            <span>{t('code.fileCount', { count: inspected.files })}</span>
          </span>
        ) : (
          <>
            <span>{t('code.distribution.icicleHint')}</span>
            <span className="mrpr-shrink-0">{t('code.distribution.colorByKind')}</span>
          </>
        )}
      </div>
    </>
  );
}
