// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestChecksPopover.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The panel header's checks line: the state's icon and the summary, which open the checks popover.
// It loads the checks of the pull request's head commit itself, so a failure shows here only.
import { useCallback, useEffect, useRef, useState } from 'react';
import FocusTrap from 'focus-trap-react';
import type { RectCords } from 'folds';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { Menu, PopOut } from '@mindroom/client-sdk/ui';
import type { PullRequest, PullRequestRef } from '../github';
import { pullRequestChecksStatePresentation } from '../presentation';
import { useChecks } from '../queries';
import { pluginRootStyle } from '../theme';
import { usePanelTokenFormFor } from '../token';
import { ChecksPopover } from './ChecksPopover';
import { checksState, summarizeChecks } from './detail.logic';

/** How long a mouse rests on the checks button before its popover opens. */
export const CHECKS_HOVER_OPEN_MS = 150;
/** How long a hover-opened popover stays after the mouse leaves so it can reach the menu. */
export const CHECKS_HOVER_CLOSE_MS = 200;

export function ChecksStatusLine({
  pullRequest,
  pullRequestRef,
}: {
  pullRequest: PullRequest;
  pullRequestRef: PullRequestRef;
}) {
  const t = usePluginTranslation('pull-requests');
  const query = useChecks(pullRequestRef, pullRequest.headSha, true);
  // The panel's token form is the one to use when a token would let the checks load.
  usePanelTokenFormFor(query.isError ? query.error : undefined);
  const [popover, setPopover] = useState<{ anchor: RectCords; mode: 'hover' | 'pinned' }>();
  const buttonRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const hoverTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const clearHoverTimer = useCallback(() => clearTimeout(hoverTimer.current), []);
  // Escape and a click outside the popover close it, as the app's own menus do.
  const close = useCallback(() => {
    clearHoverTimer();
    setPopover(undefined);
    return true;
  }, [clearHoverTimer]);
  const checks = query.isError ? undefined : query.data?.items;
  const state = checks ? checksState(checks) : 'none';
  const hasChecks = state !== 'none';
  const anchor = popover?.anchor;
  const hoverOpen = hasChecks && popover?.mode === 'hover';
  useEffect(() => {
    if (!hasChecks) close();
    return clearHoverTimer;
  }, [hasChecks, close, clearHoverTimer]);
  useEffect(() => {
    if (!hoverOpen) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (popoverRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        buttonRef.current?.focus();
      }
      close();
    };
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target instanceof Node ? event.target : null;
      if (!buttonRef.current?.contains(target) && !popoverRef.current?.contains(target)) close();
    };
    document.addEventListener('keydown', onKeyDown);
    document.addEventListener('pointerdown', onPointerDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown);
      document.removeEventListener('pointerdown', onPointerDown, true);
    };
  }, [hoverOpen, close]);
  if (query.isError) {
    const unavailable = t('checksLine.unavailable');
    return (
      <span className="mrpr-checks-line">
        <span className="mrpr-status" title={unavailable}>
          {unavailable}
        </span>
        <button type="button" className="mrpr-button" onClick={() => void query.refetch()}>
          {t('checksLine.retry')}
        </button>
      </span>
    );
  }
  if (query.data === undefined) {
    return <span className="mrpr-status">{t('checksLine.loading')}</span>;
  }
  if (!checks || state === 'none')
    return <span className="mrpr-status">{t('checksLine.none')}</span>;
  const { key, ...values } = summarizeChecks(checks);
  const summary = t(`checks.${key}`, values);
  const presentation = pullRequestChecksStatePresentation(state);
  const passed = checks.filter((check) => check.status === 'success').length;
  const onHoverLeave = (event: { pointerType: string }) => {
    if (event.pointerType !== 'mouse') return;
    clearHoverTimer();
    if (popover?.mode !== 'hover') return;
    hoverTimer.current = setTimeout(
      () => setPopover((cur) => (cur?.mode === 'hover' ? undefined : cur)),
      CHECKS_HOVER_CLOSE_MS
    );
  };
  const isOnButton = (event?: MouseEvent | TouchEvent) =>
    !!event && event.target instanceof Node && !!buttonRef.current?.contains(event.target);
  return (
    <>
      <button
        ref={buttonRef}
        type="button"
        className="mrpr-checks-button"
        aria-haspopup="dialog"
        aria-expanded={anchor !== undefined}
        aria-label={t('checksPopover.open', { summary })}
        title={anchor ? undefined : summary}
        onPointerEnter={(event) => {
          if (event.pointerType !== 'mouse') return;
          clearHoverTimer();
          if (popover || event.buttons !== 0) return;
          const el = event.currentTarget;
          hoverTimer.current = setTimeout(
            () => setPopover((cur) => cur ?? { anchor: el.getBoundingClientRect(), mode: 'hover' }),
            CHECKS_HOVER_OPEN_MS
          );
        }}
        onPointerLeave={onHoverLeave}
        onPointerDown={clearHoverTimer}
        onClick={(event) => {
          clearHoverTimer();
          setPopover(
            popover?.mode === 'pinned'
              ? undefined
              : { anchor: event.currentTarget.getBoundingClientRect(), mode: 'pinned' }
          );
        }}
      >
        <presentation.Icon aria-hidden className={`mrpr-icon ${presentation.toneClassName}`} />
        {/* One line: the summary where the tab bar has room for it, else passed over all, its
            icon the worst state (styles.css). The name and tooltip say it whole. */}
        <span aria-hidden className="mrpr-checks-full">
          {summary}
        </span>
        <span aria-hidden className="mrpr-checks-short">
          {t('checksLine.short', { passed, total: checks.length })}
        </span>
      </button>
      <PopOut
        style={{ pointerEvents: 'none' }}
        data-owns-focus={hoverOpen ? '' : undefined}
        anchor={anchor}
        position="Bottom"
        align="End"
        offset={4}
        content={
          <FocusTrap
            active={!hoverOpen}
            focusTrapOptions={{
              initialFocus: false,
              returnFocusOnDeactivate: false,
              clickOutsideDeactivates: (event?: MouseEvent | TouchEvent) =>
                isOnButton(event) ? false : close(),
              allowOutsideClick: isOnButton,
              escapeDeactivates: close,
            }}
          >
            <Menu
              ref={popoverRef}
              role="dialog"
              aria-label={t('checksPopover.label')}
              style={{ pointerEvents: 'auto' }}
              onPointerEnter={(event: { pointerType: string }) => {
                if (event.pointerType === 'mouse') clearHoverTimer();
              }}
              onPointerLeave={onHoverLeave}
            >
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
