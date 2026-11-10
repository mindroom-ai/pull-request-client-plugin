// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// What the checks popover holds: the overall result and summary, then one row per check, those that
// need attention first, then those that run, and the completed ones behind "Show all" while either
// of the first two groups has entries.
import { useState } from 'react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import type { PullRequestCheck } from '../github';
import {
  PullRequestCheckStatusIcon,
  PullRequestCheckStatusLabel,
  pullRequestChecksStatePresentation,
} from '../presentation';
import { checksState, groupChecks, summarizeChecks } from './detail.logic';

export function ChecksPopover({ checks }: { checks: PullRequestCheck[] }) {
  const t = usePluginTranslation('pull-requests');
  const [showAll, setShowAll] = useState(false);
  if (checks.length === 0) return <p className="mrpr-status">{t('checksPopover.none')}</p>;
  const state = checksState(checks);
  const heading = state === 'none' ? undefined : pullRequestChecksStatePresentation(state);
  const { key, ...values } = summarizeChecks(checks);
  const { attention, running, completed } = groupChecks(checks);
  const canCollapse = attention.length + running.length > 0 && completed.length > 0;
  const visible = [...attention, ...running, ...(showAll || !canCollapse ? completed : [])];
  const hasDetails = visible.some((check) => check.url !== null);
  return (
    <div className="mrpr-checks-popover">
      {heading ? (
        <p className="mrpr-checks-heading">
          <heading.Icon aria-hidden className={`mrpr-icon ${heading.toneClassName}`} />
          {t(`checksState.${state as Exclude<typeof state, 'none'>}`)}
        </p>
      ) : null}
      <p className="mrpr-status">{t(`checks.${key}`, values)}</p>
      <ul className={`mrpr-checks${hasDetails ? ' mrpr-checks-with-details' : ''}`}>
        {visible.map((check, index) => (
          // Check names can repeat, and these rows hold no state of their own.
          // eslint-disable-next-line react/no-array-index-key
          <li key={`${index}:${check.name}`} className="mrpr-check">
            <PullRequestCheckStatusIcon status={check.status} />
            <span className="mrpr-check-name mrpr-truncate" title={check.description ?? check.name}>
              {check.name}
            </span>
            <span className="mrpr-check-status">
              <PullRequestCheckStatusLabel check={check} />
            </span>
            {check.url === null ? null : (
              <a className="mrpr-link" href={check.url} target="_blank" rel="noopener noreferrer">
                {t('checksPopover.details')}
              </a>
            )}
          </li>
        ))}
      </ul>
      {canCollapse ? (
        <button
          type="button"
          className="mrpr-button mrpr-button-quiet"
          aria-expanded={showAll}
          onClick={() => setShowAll(!showAll)}
        >
          {showAll ? t('checksPopover.showLess') : t('checksPopover.showAll')}
        </button>
      ) : null}
    </div>
  );
}
