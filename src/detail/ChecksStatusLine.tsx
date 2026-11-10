// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The panel header's checks line: the state's icon and the summary, which open the checks popover.
// It loads the checks of the pull request's head commit itself, so a failure shows here only.
import { useState, type MouseEvent } from 'react';
import FocusTrap from 'focus-trap-react';
import type { RectCords } from 'folds';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { Menu, PopOut } from '@mindroom/client-sdk/ui';
import type { PullRequest, PullRequestRef } from '../github';
import { pullRequestChecksStatePresentation } from '../presentation';
import { useChecks } from '../queries';
import { pluginRootStyle } from '../theme';
import { ChecksPopover } from './ChecksPopover';
import { checksState, summarizeChecks } from './detail.logic';

export function ChecksStatusLine({
  pullRequest,
  pullRequestRef,
}: {
  pullRequest: PullRequest;
  pullRequestRef: PullRequestRef;
}) {
  const t = usePluginTranslation('pull-requests');
  const query = useChecks(pullRequestRef, pullRequest.headSha, true);
  const [anchor, setAnchor] = useState<RectCords>();
  // Escape and a click outside the popover close it, as the app's own menus do.
  const close = () => {
    setAnchor(undefined);
    return true;
  };
  if (query.isError) {
    return (
      <span className="mrpr-checks-line">
        <span className="mrpr-status">{t('checksLine.unavailable')}</span>
        <button type="button" className="mrpr-button" onClick={() => void query.refetch()}>
          {t('checksLine.retry')}
        </button>
      </span>
    );
  }
  if (query.data === undefined) {
    return <span className="mrpr-status">{t('checksLine.loading')}</span>;
  }
  const checks = query.data.items;
  const state = checksState(checks);
  if (state === 'none') return <span className="mrpr-status">{t('checksLine.none')}</span>;
  const { key, ...values } = summarizeChecks(checks);
  const summary = t(`checks.${key}`, values);
  const presentation = pullRequestChecksStatePresentation(state);
  return (
    <>
      <button
        type="button"
        className="mrpr-checks-button"
        aria-haspopup="dialog"
        aria-expanded={anchor !== undefined}
        aria-label={t('checksPopover.open', { summary })}
        onClick={(event: MouseEvent<HTMLButtonElement>) =>
          setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect())
        }
      >
        <presentation.Icon aria-hidden className={`mrpr-icon ${presentation.toneClassName}`} />
        <span>{summary}</span>
      </button>
      <PopOut
        anchor={anchor}
        position="Bottom"
        align="End"
        offset={4}
        content={
          <FocusTrap
            focusTrapOptions={{
              initialFocus: false,
              returnFocusOnDeactivate: false,
              clickOutsideDeactivates: close,
              escapeDeactivates: close,
            }}
          >
            <Menu role="dialog" aria-label={t('checksPopover.label')}>
              <div className="mrpr-root mrpr-popover" style={pluginRootStyle()}>
                <ChecksPopover
                  checks={checks}
                  truncatedUrl={query.data.truncated ? `${pullRequest.url}/checks` : undefined}
                />
              </div>
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}
