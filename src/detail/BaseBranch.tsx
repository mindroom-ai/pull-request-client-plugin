// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestBaseBranch.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The base branch of the header, with a warning button that opens a popover when the pull request
// has fallen behind it or conflicts with it.
import { useRef, useState, type MouseEvent } from 'react';
import FocusTrap from 'focus-trap-react';
import type { RectCords } from 'folds';
import { TriangleAlert } from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { Menu, PopOut } from '@mindroom/client-sdk/ui';
import { pluginRootStyle } from '../theme';

export function BaseBranch({
  baseBranch,
  headBranch,
  freshness,
}: {
  baseBranch: string;
  headBranch: string;
  /** Undefined when the branch is neither behind nor conflicting. */
  freshness: { behind: number; conflicts: boolean } | undefined;
}) {
  const t = usePluginTranslation('pull-requests');
  const [anchor, setAnchor] = useState<RectCords>();
  const contentRef = useRef<HTMLDivElement>(null);
  // Escape and a click outside the popover close it, as the app's own menus do.
  const close = () => {
    setAnchor(undefined);
    return true;
  };
  const name = <span className="mrpr-truncate">{baseBranch}</span>;
  if (!freshness) return <span className="mrpr-base-ref mrpr-base-plain">{name}</span>;
  const label = t('base.warning', { base: baseBranch });
  return (
    <>
      <button
        type="button"
        className="mrpr-base-ref mrpr-base-warning"
        aria-haspopup="dialog"
        aria-expanded={anchor !== undefined}
        aria-label={label}
        onClick={(event: MouseEvent<HTMLButtonElement>) =>
          setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect())
        }
      >
        {name}
        <TriangleAlert aria-hidden className="mrpr-arrow mrpr-tone-warning" />
      </button>
      <PopOut
        anchor={anchor}
        position="Bottom"
        align="Start"
        offset={4}
        content={
          <FocusTrap
            focusTrapOptions={{
              initialFocus: false,
              // The popover holds text only, which the trap needs a focusable stand-in for.
              fallbackFocus: () => contentRef.current ?? document.body,
              returnFocusOnDeactivate: false,
              clickOutsideDeactivates: close,
              escapeDeactivates: close,
            }}
          >
            <Menu role="dialog" aria-label={label}>
              <div
                ref={contentRef}
                tabIndex={-1}
                className="mrpr-root mrpr-popover"
                style={pluginRootStyle()}
              >
                {freshness.behind > 0 ? (
                  <p className="mrpr-popover-line">
                    {t('base.behind', {
                      count: freshness.behind,
                      head: headBranch,
                      base: baseBranch,
                    })}
                  </p>
                ) : null}
                {freshness.conflicts ? (
                  <p className="mrpr-popover-line">{t('base.conflicts')}</p>
                ) : null}
              </div>
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}
