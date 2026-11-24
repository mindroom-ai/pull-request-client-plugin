// Two-column Bars view for Line Distribution: directory drill-down column + largest-files column,
// compact top-5 default with concentration footer and expandable Show all toggle.
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { useMemo, useState, type ReactNode } from 'react';
import {
  COMPACT_ROW_LIMIT,
  buildDirectoryRows,
  computeBarWidths,
  formatShare,
  metricValue,
  sortFilesByMetric,
  statusBadge,
  type DistributionMetric,
  type DistributionViewProps,
} from './lineDistribution.logic';

function BarRow(props: {
  counts: { additions: number; deletions: number };
  maxValue: number;
  scopeTotal: number;
  metric: DistributionMetric;
  fmt: Intl.NumberFormat;
  onClick: () => void;
  children: ReactNode;
}) {
  const { counts, maxValue, scopeTotal, metric, fmt, onClick, children } = props;
  const { addPct, delPct } = computeBarWidths(counts, maxValue, metric);
  const share = formatShare(metricValue(counts, metric), scopeTotal);
  const showAdd = counts.additions > 0 || metric === 'additions' || counts.deletions === 0;
  const showDel = metric === 'total' && counts.deletions > 0;
  return (
    <button type="button" className="mrpr-dist-bar-row" onClick={onClick}>
      <span className="mrpr-dist-bar-name-col">{children}</span>
      <span className="mrpr-dist-bar-stats mrpr-tabular">
        {showAdd ? <span className="mrpr-added">+{fmt.format(counts.additions)}</span> : null}
        {showDel ? <span className="mrpr-removed">-{fmt.format(counts.deletions)}</span> : null}
        <span className="mrpr-dist-bar-pct">{share}</span>
      </span>
      <span aria-hidden className="mrpr-dist-bar-track">
        {addPct > 0 ? (
          <span className="mrpr-dist-bar-add" style={{ inlineSize: `${addPct.toFixed(2)}%` }} />
        ) : null}
        {delPct > 0 ? (
          <span className="mrpr-dist-bar-del" style={{ inlineSize: `${delPct.toFixed(2)}%` }} />
        ) : null}
      </span>
    </button>
  );
}

export function DistributionBars(props: DistributionViewProps) {
  const { scopedFiles, dirPrefix, metric, scopeTotal, fmt, onDirPrefixChange, onSelectFile } =
    props;
  const t = usePluginTranslation('pull-requests');
  const [expandedPrefix, setExpandedPrefix] = useState<string | null>(null);
  const expanded = expandedPrefix === dirPrefix;

  const dirRows = useMemo(
    () => buildDirectoryRows(scopedFiles, dirPrefix, metric),
    [scopedFiles, dirPrefix, metric]
  );
  const sortedFiles = useMemo(() => sortFilesByMetric(scopedFiles, metric), [scopedFiles, metric]);
  const hasSubdirs = dirRows.some((row) => row.file === null);
  const maxDir = Math.max(0, ...dirRows.map((row) => row.value));
  const maxFile = Math.max(0, ...sortedFiles.map((file) => metricValue(file, metric)));
  const limit = expanded ? sortedFiles.length : COMPACT_ROW_LIMIT;

  const topTotal = sortedFiles
    .slice(0, COMPACT_ROW_LIMIT)
    .reduce((sum, file) => sum + metricValue(file, metric), 0);
  const concentrationText =
    sortedFiles.length > COMPACT_ROW_LIMIT
      ? t(dirPrefix ? 'code.distribution.topFilesFolder' : 'code.distribution.topFiles', {
          count: COMPACT_ROW_LIMIT,
          share: formatShare(topTotal, scopeTotal),
        })
      : sortedFiles.length > 1
        ? t(dirPrefix ? 'code.distribution.largestFileFolder' : 'code.distribution.largestFile', {
            share: formatShare(metricValue(sortedFiles[0], metric), scopeTotal),
          })
        : t('code.distribution.lineCount', {
            count: scopeTotal,
            formatted: fmt.format(scopeTotal),
          });

  return (
    <>
      <div
        className={hasSubdirs ? 'mrpr-dist-bars-grid mrpr-dist-bars-split' : 'mrpr-dist-bars-grid'}
      >
        {hasSubdirs ? (
          <div className="mrpr-dist-column">
            <div className="mrpr-dist-sec-head">
              <span className="mrpr-dist-sec-title">
                {dirPrefix
                  ? t('code.distribution.foldersIn', { prefix: dirPrefix })
                  : t('code.distribution.byDirectory')}
              </span>
              <span className="mrpr-dist-sec-meta">{t('code.distribution.clickToDrill')}</span>
            </div>
            <div className="mrpr-dist-bar-list">
              {dirRows.slice(0, limit).map((row) => (
                <BarRow
                  key={row.dirPrefix || row.name}
                  counts={row}
                  maxValue={maxDir}
                  scopeTotal={scopeTotal}
                  metric={metric}
                  fmt={fmt}
                  onClick={() =>
                    row.file ? onSelectFile(row.file.path) : onDirPrefixChange(row.dirPrefix)
                  }
                >
                  <span className="mrpr-dist-bar-name" title={row.dirPrefix || row.file?.path}>
                    {row.name}
                  </span>
                  {row.file === null ? (
                    <span className="mrpr-dist-bar-sub">
                      {t('code.fileCount', { count: row.files })}
                    </span>
                  ) : null}
                </BarRow>
              ))}
            </div>
          </div>
        ) : null}

        <div className="mrpr-dist-column">
          <div className="mrpr-dist-sec-head">
            <span className="mrpr-dist-sec-title">{t('code.distribution.largestFiles')}</span>
            <span className="mrpr-dist-sec-meta">{t('code.distribution.clickToJump')}</span>
          </div>
          <div className="mrpr-dist-bar-list">
            {sortedFiles.slice(0, limit).map((file) => {
              const badge = statusBadge(file.status);
              const statusLabel = t(`code.distribution.status.${badge.key}`);
              const slash = file.path.lastIndexOf('/');
              const base = slash === -1 ? file.path : file.path.slice(slash + 1);
              const dir = slash === -1 ? '' : file.path.slice(0, slash);
              return (
                <BarRow
                  key={file.path}
                  counts={file}
                  maxValue={maxFile}
                  scopeTotal={scopeTotal}
                  metric={metric}
                  fmt={fmt}
                  onClick={() => onSelectFile(file.path)}
                >
                  <span aria-hidden className="mrpr-dist-dot" data-kind={file.kind} />
                  <span className="mrpr-dist-status" data-status={badge.tone} title={statusLabel}>
                    <span aria-hidden="true">{badge.letter}</span>
                    <span className="mrpr-sr-only">{statusLabel}</span>
                  </span>
                  <span className="mrpr-dist-bar-name" title={file.path}>
                    {base}
                  </span>
                  {dir ? (
                    <span className="mrpr-dist-bar-sub" title={dir}>
                      {dir}
                    </span>
                  ) : null}
                </BarRow>
              );
            })}
          </div>
        </div>
      </div>

      <div className="mrpr-dist-foot">
        <span className="mrpr-tabular">{concentrationText}</span>
        {sortedFiles.length > COMPACT_ROW_LIMIT ? (
          <button
            type="button"
            className="mrpr-link-button"
            onClick={() => setExpandedPrefix(expanded ? null : dirPrefix)}
          >
            {expanded
              ? t('code.distribution.showTop', { count: COMPACT_ROW_LIMIT })
              : t('code.distribution.showAll', { count: sortedFiles.length })}
          </button>
        ) : null}
      </div>
    </>
  );
}
