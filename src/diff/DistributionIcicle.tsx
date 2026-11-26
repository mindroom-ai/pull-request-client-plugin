// Dynamic-depth SVG Icicle flamegraph for Line Distribution: responsive page-zoomed viewBox,
// hover/focus inspect summary, opaque kind fills, and keyboard-accessible interactive nodes.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { useLanguage } from '../presentation';
import { useRootFontSize } from '../rootFontSize';
import {
  ICICLE_DEFAULT_WIDTH,
  ICICLE_MAX_DEPTH,
  ICICLE_ROW_HEIGHT,
  buildIcicleTree,
  formatShare,
  formatSigned,
  layoutIcicle,
  type DistributionViewProps,
} from './lineDistribution.logic';

const truncateLabel = (text: string, width: number, padX: number, charWidth: number): string => {
  const maxChars = Math.max(3, Math.floor((width - padX * 2) / charWidth));
  return text.length > maxChars ? `${text.slice(0, maxChars - 1)}…` : text;
};

const fitSubStat = (
  candidates: readonly string[],
  width: number,
  padX: number,
  subCharWidth: number
): string | null =>
  candidates.find((text) => text.length * subCharWidth <= width - padX * 2) ?? null;

export function DistributionIcicle(props: DistributionViewProps) {
  const { scopedFiles, dirPrefix, metric, scopeTotal, fmt, onDirPrefixChange, onSelectFile } =
    props;
  const t = usePluginTranslation('pull-requests');
  const language = useLanguage();
  const compactFmt = useMemo(
    () => new Intl.NumberFormat(language, { notation: 'compact', maximumFractionDigits: 1 }),
    [language]
  );
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
  const subCharWidth = 6 * zoom;
  const minLabelWidth = 34 * zoom;

  const tree = useMemo(
    () => buildIcicleTree(scopedFiles, dirPrefix, metric),
    [scopedFiles, dirPrefix, metric]
  );
  const isNet = metric === 'net';
  const { rects, height } = useMemo(
    () => layoutIcicle(tree, width, ICICLE_MAX_DEPTH, rowHeight, !isNet),
    [tree, width, rowHeight, isNet]
  );
  const hasRects = rects.length > 0;

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
  }, [hasRects]);

  const inspectedPath = inspectedState?.scope === dirPrefix ? inspectedState.path : null;
  const inspected =
    inspectedPath === null
      ? null
      : (rects.find((r) => r.node.path === inspectedPath)?.node ?? null);

  if (!hasRects) {
    return (
      <div ref={boxRef} className="mrpr-dist-icicle-box">
        <div className="mrpr-dist-icicle-empty">
          {t(isNet ? 'code.distribution.noNetChange' : 'code.distribution.noMatchingFiles')}
        </div>
      </div>
    );
  }
  const inspectedDelta = inspected ? inspected.additions - inspected.deletions : 0;
  const inspectedNetClass =
    inspectedDelta > 0 ? 'mrpr-added' : inspectedDelta < 0 ? 'mrpr-removed' : 'mrpr-dist-net-zero';

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
            const isNeutral = isRoot || (isNet && !node.file);
            const interactive = !isRoot;
            const delta = node.additions - node.deletions;
            const netTone =
              isNet && node.file && delta !== 0 ? (delta > 0 ? 'added' : 'removed') : undefined;
            const displayPath = node.path || t('code.distribution.allFiles');
            const displayName = node.name || t('code.distribution.allFiles');
            const share = formatShare(node.value, scopeTotal);
            const label = t(
              isNet ? 'code.distribution.icicleNodeLabelNet' : 'code.distribution.icicleNodeLabel',
              {
                path: displayPath,
                net: formatSigned(delta, fmt),
                additions: fmt.format(node.additions),
                deletions: fmt.format(node.deletions),
                share,
                files: t('code.fileCount', { count: node.files }),
              }
            );
            const activate = () => {
              if (node.file) onSelectFile(node.file.path);
              else onDirPrefixChange(node.path);
            };
            const clearInspect = () =>
              setInspectedState((cur) => (cur?.path === node.path ? null : cur));
            const labelClass = isNeutral
              ? 'mrpr-dist-icicle-root-label'
              : node.file
                ? 'mrpr-dist-icicle-label is-file'
                : 'mrpr-dist-icicle-label';
            const compactValue = isNet
              ? formatSigned(delta, compactFmt)
              : metric === 'additions'
                ? `+${compactFmt.format(node.additions)}`
                : compactFmt.format(node.value);
            const subCandidates = isNet
              ? node.file
                ? [compactValue]
                : [t('code.distribution.netCount', { net: compactValue }), compactValue]
              : [`${share} · ${compactValue}`, compactValue];
            const subStat =
              isNet || w > minLabelWidth ? fitSubStat(subCandidates, w, padX, subCharWidth) : null;
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
                data-net={netTone}
                onMouseEnter={() => setInspectedState({ scope: dirPrefix, path: node.path })}
                onMouseLeave={clearInspect}
                {...interactiveProps}
              >
                <title>{label}</title>
                <rect
                  className={isNeutral ? 'mrpr-dist-icicle-root-rect' : 'mrpr-dist-icicle-rect'}
                  data-kind={isNeutral || netTone ? undefined : node.dominantKind}
                  x={(x + 0.5).toFixed(1)}
                  y={(y + 0.5).toFixed(1)}
                  width={Math.max(1, w - 1).toFixed(1)}
                  height={(h - 1).toFixed(1)}
                  rx="2"
                  fillOpacity={isNeutral ? undefined : 1}
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
                {subStat ? (
                  <text
                    className={isNeutral ? 'mrpr-dist-icicle-root-sub' : 'mrpr-dist-icicle-sub'}
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
            {isNet ? (
              <span className={inspectedNetClass}>
                {t('code.distribution.netCount', { net: formatSigned(inspectedDelta, fmt) })}
              </span>
            ) : null}
            <span className="mrpr-added">+{fmt.format(inspected.additions)}</span>
            {metric !== 'additions' && inspected.deletions > 0 ? (
              <span className="mrpr-removed">-{fmt.format(inspected.deletions)}</span>
            ) : null}
            <span>{formatShare(inspected.value, scopeTotal)}</span>
            <span>{t('code.fileCount', { count: inspected.files })}</span>
          </span>
        ) : (
          <>
            <span>{t('code.distribution.icicleHint')}</span>
            {isNet ? (
              <span className="mrpr-dist-net-legend mrpr-shrink-0">
                <span aria-hidden className="mrpr-dist-swatch" data-net="added" />
                <span>{t('code.distribution.netGrows')}</span>
                <span aria-hidden className="mrpr-dist-swatch" data-net="removed" />
                <span>{t('code.distribution.netShrinks')}</span>
              </span>
            ) : (
              <span className="mrpr-shrink-0">{t('code.distribution.colorByKind')}</span>
            )}
          </>
        )}
      </div>
    </>
  );
}
