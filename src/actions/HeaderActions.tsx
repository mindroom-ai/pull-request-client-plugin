// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestDetailActions.tsx and PullRequestActionsMenu.tsx at 428d3659), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The header's actions on a pull request: its one primary control, the menu of the rest, the
// dialog that asks before a branch is deleted, and the line under the header that says what runs
// and what came of it. A viewer who cannot write to the repository, or has no token, sees none.
// While the requests go through MindRoom, the menu also says as whom and holds what changes that
// (a token in this browser instead, removing the token saved there), for writers or not.
import { useEffect, useId, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import FocusTrap from 'focus-trap-react';
import {
  Icons,
  Line,
  Overlay,
  OverlayBackdrop,
  OverlayCenter,
  type IconSrc,
  type RectCords,
} from 'folds';
import { MoreHorizontal, X } from 'lucide-react';
import { useQueryClient } from '@tanstack/react-query';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import {
  Dialog,
  IconButton,
  IconTooltip,
  Menu,
  MenuEntry,
  MenuGroup,
  PopOut,
} from '@mindroom/client-sdk/ui';
import { checksState } from '../detail/detail.logic';
import {
  pullRequestUrl,
  type PullRequest,
  type PullRequestAction,
  type PullRequestRef,
} from '../github';
import {
  pullRequestKey,
  repositoryKey,
  useChecks,
  useHeadBranchSha,
  useMergeableRecheck,
} from '../queries';
import { pluginRootStyle } from '../theme';
import { useGitHubAccess, useServerTokenRemoval } from '../token';
import { mayDeleteBranch, menuActions, primaryControl, showsOutcome } from './actions.logic';
import { useInlineConfirm } from './useInlineConfirm';
import type { ActionResult, usePullRequestActions } from './usePullRequestActions';

type Actions = ReturnType<typeof usePullRequestActions>;

// The menu's row for each action it can list, by its label in `actions`.
const ROWS: Partial<Record<PullRequestAction, { label: string; icon: IconSrc; critical?: true }>> =
  {
    merge: { label: 'mergeNow', icon: Icons.Check },
    'enable-auto-merge': { label: 'enableAutoMerge', icon: Icons.Clock },
    'disable-auto-merge': { label: 'disableAutoMerge', icon: Icons.Cross },
    ready: { label: 'ready', icon: Icons.Eye },
    draft: { label: 'draft', icon: Icons.Pencil },
    close: { label: 'close', icon: Icons.NoEntry, critical: true },
    reopen: { label: 'reopen', icon: Icons.ArrowGoLeft },
    'delete-branch': { label: 'deleteBranch', icon: Icons.Delete, critical: true },
  };

// What asks for a second click, with what the armed control says.
const CONFIRM: Partial<Record<PullRequestAction, string>> = {
  merge: 'actions.confirm.merge',
  'enable-auto-merge': 'actions.confirm.autoMerge',
  close: 'actions.confirm.close',
};

// The successes nothing else on screen shows, so the line under the header shows them. The
// others the header shows itself (a badge, another control), and the line only announces them.
const SHOWN_DONE: ReadonlySet<PullRequestAction> = new Set([
  'delete-branch',
  'update-branch',
  'update-branch-rebase',
]);

/**
 * Whether a success is only announced, not shown as a line: the header shows it itself. Not
 * while the pull request could not be read again after the action and the one on screen is
 * still from before it: the header then offers Merge on a merged pull request, and the line is
 * all that says it is merged.
 */
function isOnlyAnnounced(result: ActionResult | null, pr: PullRequest): boolean {
  if (result?.outcome !== 'done' || SHOWN_DONE.has(result.action)) return false;
  return result.unread !== true || showsOutcome(pr, result.action);
}

export function HeaderActions({
  pullRequestRef,
  pullRequest: pr,
  actions,
  onUseToken,
}: {
  pullRequestRef: PullRequestRef;
  pullRequest: PullRequest;
  actions: Actions;
  /** Opens the panel's form to use a token in this browser; without it the menu does not offer it. */
  onUseToken?: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const { repo, method, chooseMethod, pending, result, perform, dismissResult } = actions;
  const canWrite = repo?.canWrite === true;
  const { via, login } = useGitHubAccess();
  const signedIn = via === 'server';
  const removal = useServerTokenRemoval();
  const statusId = useId();
  // The same query as the checks line, so it costs no request of its own where that one shows.
  const checks = useChecks(pullRequestRef, pr.headSha, canWrite);
  // While GitHub still computes whether it merges, the pull request is read again for that.
  const checking = useMergeableRecheck(pullRequestRef, pr, canWrite, pending !== null);
  // Asked only for a branch that could be deleted at all; the menu offers it while it still
  // ends where the pull request does, so not once it is deleted.
  const headBranch = useHeadBranchSha(
    pullRequestRef,
    pr,
    repo !== undefined && mayDeleteBranch(pr, repo)
  );
  const url = pullRequestUrl(pullRequestRef);
  const confirm = useInlineConfirm(url);
  const queryClient = useQueryClient();
  const [anchor, setAnchor] = useState<RectCords>();
  // The pull request whose branch the dialog asks about, so showing another one closes it.
  const [deleting, setDeleting] = useState<string | null>(null);
  const moreRef = useRef<HTMLButtonElement | null>(null);
  // Set when a choice or Escape closes the menu, which then gives the focus back to its button,
  // once the menu's focus trap is gone.
  const refocus = useRef(false);
  useEffect(() => {
    if (anchor !== undefined || !refocus.current) return;
    refocus.current = false;
    moreRef.current?.focus();
  }, [anchor]);
  // While an action runs no other starts, so its menu does not stay open either.
  if (pending !== null && anchor !== undefined) setAnchor(undefined);
  const busy = pending !== null;
  // An action may take the control that had the focus away with it: a merged pull request has
  // no Merge, an updated branch no warning. The focus then falls to the page, where a keyboard
  // or a screen reader starts over from the top, so when the action ends it goes to More
  // actions, which every state keeps. Focus the viewer put elsewhere meanwhile stays there.
  const wasBusy = useRef(false);
  useEffect(() => {
    if (busy) {
      wasBusy.current = true;
      return;
    }
    if (!wasBusy.current) return;
    wasBusy.current = false;
    const focused = document.activeElement;
    if (focused === null || focused === document.body) {
      moreRef.current?.focus({ preventScroll: true });
    }
  }, [busy]);

  const writable = canWrite ? repo : undefined;
  if (!writable && !signedIn) return null;

  // The two controls that can have the focus when an action starts stay focusable while it
  // runs: `disabled` would drop the focus to the page, so they are off by ARIA and ignore the
  // click instead.
  const off = busy ? { 'aria-disabled': true } : undefined;
  const primary =
    writable &&
    primaryControl(
      pr,
      writable,
      checks.data ? checksState(checks.data.items) : undefined,
      checking
    );
  const listed = writable && primary ? menuActions(pr, writable, primary, headBranch.data) : [];
  const methods = writable?.mergeMethods ?? [];
  const showsMethods =
    pr.state === 'open' &&
    !pr.draft &&
    primary !== 'conflicts' &&
    primary !== 'checking' &&
    methods.length > 1;
  // The action the primary control starts, which shows that it runs itself.
  const primaryAction: PullRequestAction | null =
    primary === 'merge' || primary === 'enable-auto-merge' || primary === 'ready' ? primary : null;

  const closeMenu = () => {
    setAnchor(undefined);
    return true;
  };
  const choose = (run: () => void) => {
    refocus.current = true;
    setAnchor(undefined);
    run();
  };
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: pullRequestKey(pullRequestRef) });
    void queryClient.invalidateQueries({ queryKey: repositoryKey(pullRequestRef) });
  };

  const primaryLabel = (action: PullRequestAction, idle: string) => {
    if (pending === action) return t(`actions.pending.${action}`);
    const armed = CONFIRM[action];
    return armed !== undefined && confirm.isArmed(action) ? t(armed) : idle;
  };

  let primaryControlElement: ReactNode = null;
  if (primary === 'conflicts') {
    primaryControlElement = (
      <span className="mrpr-badge mrpr-badge-error">{t('actions.conflicts')}</span>
    );
  } else if (primary === 'checking') {
    // The button Merge is, off while GitHub computes: one focused keeps the focus.
    primaryControlElement = (
      <button
        type="button"
        className="mrpr-button mrpr-button-primary"
        aria-disabled
        aria-live="polite"
      >
        {t('actions.checking')}
      </button>
    );
  } else if (primary === 'ready') {
    primaryControlElement = (
      <button
        type="button"
        className="mrpr-button mrpr-button-primary"
        {...off}
        onClick={busy ? undefined : () => perform('ready')}
      >
        {primaryLabel('ready', t('actions.ready'))}
      </button>
    );
  } else if ((primary === 'merge' || primary === 'enable-auto-merge') && method !== null) {
    const idle =
      primary === 'merge' ? t(`actions.merge.${method}`) : t('actions.autoMerge', { method });
    const { onClick, ...armable } = confirm.props(primary, () => perform(primary));
    primaryControlElement = (
      <button
        type="button"
        className="mrpr-button mrpr-button-primary"
        // Says what it became, Checking whether it can merge... among them.
        aria-live="polite"
        {...off}
        {...armable}
        onClick={busy ? undefined : onClick}
      >
        {primaryLabel(primary, idle)}
      </button>
    );
  }

  const row = (action: PullRequestAction) => {
    const entry = ROWS[action];
    if (!entry) return null;
    const label = t(`actions.${entry.label}`);
    if (action === 'delete-branch') {
      return (
        <MenuEntry
          key={action}
          role="menuitem"
          label={label}
          icon={entry.icon}
          critical={entry.critical}
          disabled={busy}
          onSelect={() => {
            setAnchor(undefined);
            setDeleting(url);
          }}
        />
      );
    }
    const confirmLabel = CONFIRM[action];
    if (confirmLabel) {
      const armed = confirm.isArmed(action);
      const { ref, onClick, onBlur } = confirm.props(action, () => choose(() => perform(action)));
      // MenuEntry takes no ref, so its wrapper holds the one that disarms on a click outside.
      return (
        <span key={action} ref={ref} className="mrpr-menu-slot">
          <MenuEntry
            role="menuitem"
            label={armed ? t(confirmLabel) : label}
            icon={entry.icon}
            critical={entry.critical}
            disabled={busy}
            onSelect={onClick}
            onBlur={onBlur}
          />
        </span>
      );
    }
    return (
      <MenuEntry
        key={action}
        role="menuitem"
        label={label}
        icon={entry.icon}
        critical={entry.critical}
        disabled={busy}
        onSelect={() => choose(() => perform(action))}
      />
    );
  };

  const more = t('actions.more');
  return (
    <>
      {primaryControlElement}
      <IconTooltip label={more} align="End">
        {(triggerRef) => (
          <IconButton
            ref={(node: HTMLButtonElement | null) => {
              triggerRef(node);
              moreRef.current = node;
            }}
            size="300"
            radii="300"
            className="mrpr-header-more"
            aria-label={more}
            aria-haspopup="menu"
            aria-expanded={anchor !== undefined}
            {...off}
            onClick={(event: MouseEvent<HTMLButtonElement>) => {
              if (busy) return;
              setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect());
            }}
          >
            <MoreHorizontal aria-hidden className="mrpr-button-icon" />
          </IconButton>
        )}
      </IconTooltip>
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
              clickOutsideDeactivates: closeMenu,
              escapeDeactivates: () => {
                refocus.current = true;
                return closeMenu();
              },
            }}
          >
            <Menu role="menu" aria-label={more}>
              <div className="mrpr-root mrpr-actions-menu" style={pluginRootStyle()}>
                {showsMethods ? (
                  <>
                    <MenuGroup>
                      <div
                        role="group"
                        aria-label={t('actions.methodGroup')}
                        className="mrpr-menu-radio-group"
                      >
                        {methods.map((option) => (
                          <MenuEntry
                            key={option}
                            role="menuitemradio"
                            aria-checked={option === method}
                            label={t(`actions.merge.${option}`)}
                            icon={Icons.Check}
                            // Only the chosen method shows its check mark.
                            after={
                              option === method ? undefined : (
                                <span aria-hidden className="mrpr-menu-icon-space" />
                              )
                            }
                            disabled={busy}
                            onSelect={() => choose(() => chooseMethod(option))}
                          />
                        ))}
                      </div>
                    </MenuGroup>
                    <Line variant="Surface" size="300" />
                  </>
                ) : null}
                {listed.length > 0 ? (
                  <>
                    <MenuGroup>{listed.map(row)}</MenuGroup>
                    <Line variant="Surface" size="300" />
                  </>
                ) : null}
                <MenuGroup>
                  <MenuEntry
                    role="menuitem"
                    label={t('actions.refresh')}
                    icon={Icons.Reload}
                    disabled={busy}
                    onSelect={() => choose(refresh)}
                  />
                </MenuGroup>
                {signedIn ? (
                  <>
                    <Line variant="Surface" size="300" />
                    <MenuGroup>
                      {/* Who the requests go as, which only labels the entries that change it. */}
                      <div role="group" aria-labelledby={statusId} className="mrpr-menu-account">
                        <p id={statusId} className="mrpr-menu-status">
                          {login ? t('token.menuStatus', { login }) : t('token.menuStatusNoLogin')}
                        </p>
                        {onUseToken ? (
                          <MenuEntry
                            role="menuitem"
                            label={t('token.useToken')}
                            icon={Icons.Lock}
                            onSelect={() => {
                              // The form takes the focus once it shows.
                              setAnchor(undefined);
                              onUseToken();
                            }}
                          />
                        ) : null}
                        {removal.shown ? (
                          <MenuEntry
                            role="menuitem"
                            label={t('token.remove')}
                            icon={Icons.Delete}
                            critical
                            description={
                              removal.appConnected ? t('token.removeFallsBack') : undefined
                            }
                            disabled={removal.writing}
                            onSelect={() => {
                              // The entry goes with the menu: the panel's note takes the focus.
                              setAnchor(undefined);
                              void removal.remove(null);
                            }}
                          />
                        ) : null}
                      </div>
                    </MenuGroup>
                  </>
                ) : null}
              </div>
            </Menu>
          </FocusTrap>
        }
      />
      {removal.failed ? (
        <span role="alert" className="mrpr-status">
          {t('token.removeFailed')}
        </span>
      ) : null}
      {writable ? (
        <ResultLine
          pending={pending}
          pendingShown={pending !== primaryAction}
          result={result}
          resultAnnounced={isOnlyAnnounced(result, pr)}
          onDismiss={dismissResult}
        />
      ) : null}
      {deleting === url ? (
        <DeleteBranchDialog
          branch={pr.headRef}
          repository={pr.headRepo ?? `${pullRequestRef.owner}/${pullRequestRef.repo}`}
          returnFocus={() => moreRef.current ?? false}
          onCancel={() => setDeleting(null)}
          onConfirm={() => {
            setDeleting(null);
            perform('delete-branch');
          }}
        />
      ) : null}
    </>
  );
}

/**
 * What runs, and what came of the last action, as a status region: a screen reader announces
 * every action that starts and how it ended. It shows as a line only what no control on screen
 * says: an action a menu started (`pendingShown`), a failure with why, and a success the header
 * does not show itself; the rest (`resultAnnounced`) it holds for the screen reader alone,
 * without a Dismiss. The
 * region stays drawn while it has nothing to say, as some screen readers announce only a change
 * in one already there.
 */
function ResultLine({
  pending,
  pendingShown,
  result,
  resultAnnounced,
  onDismiss,
}: {
  pending: PullRequestAction | null;
  pendingShown: boolean;
  result: ActionResult | null;
  resultAnnounced: boolean;
  onDismiss: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const { via, connection } = useGitHubAccess();
  const announced = pending === null && resultAnnounced;
  const shown = pending === null && !announced ? result : null;
  let content: ReactNode = null;
  if (pending !== null) {
    content = t(`actions.pending.${pending}`);
  } else if (result !== null && announced) {
    content = t(`actions.done.${result.action}`);
  } else if (shown !== null) {
    const dismiss = t('actions.dismiss');
    let text: ReactNode;
    if (shown.outcome !== 'failed') {
      text = <span>{t(`actions.${shown.outcome}.${shown.action}`)}</span>;
    } else {
      const { kind, status, detail } = shown.error;
      // A refusal is GitHub's reason alone. Any other failure has a hint first, then GitHub's
      // reason when it gave one: an organization that has not allowed the token reads as that
      // and not only as missing access, and a limit or a server error says which. A failure
      // GitHub answered is not one of reaching it. A refused token needs no more than its hint.
      const hint =
        kind === 'refused'
          ? null
          : t(
              kind === 'failed' && status !== 0
                ? 'actions.hint.server'
                : kind === 'noAccess' && via === 'server'
                ? connection === 'token'
                  ? 'actions.hint.noAccessServerToken'
                  : 'actions.hint.noAccessServer'
                : kind === 'badToken' && via === 'server'
                ? connection === 'token'
                  ? 'actions.hint.badServerToken'
                  : 'actions.hint.badConnection'
                : `actions.hint.${kind}`
            );
      const why = [hint, kind === 'badToken' ? null : detail].filter(Boolean).join(' ');
      text = (
        <span>
          <strong className="mrpr-action-result-title">
            {t(`actions.failed.${shown.action}`)}
          </strong>
          {why ? ` ${why}` : null}
        </span>
      );
    }
    content = (
      <>
        {text}
        <IconTooltip label={dismiss}>
          {(triggerRef) => (
            <IconButton
              ref={triggerRef}
              size="300"
              radii="300"
              className="mrpr-action-result-dismiss"
              aria-label={dismiss}
              onClick={onDismiss}
            >
              <X aria-hidden className="mrpr-button-icon" />
            </IconButton>
          )}
        </IconTooltip>
      </>
    );
  }
  const visible = pending !== null ? pendingShown : shown !== null;
  return (
    <div role="status" className={visible ? 'mrpr-action-result' : 'mrpr-sr-only'}>
      {content}
    </div>
  );
}

/** Asks before the branch goes: deleting it on GitHub cannot be taken back from here. */
function DeleteBranchDialog({
  branch,
  repository,
  returnFocus,
  onCancel,
  onConfirm,
}: {
  branch: string;
  repository: string;
  returnFocus: () => HTMLElement | false;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const titleId = useId();
  const bodyId = useId();
  const cancel = () => {
    onCancel();
    return true;
  };
  return (
    <Overlay open backdrop={<OverlayBackdrop />}>
      <OverlayCenter>
        <FocusTrap
          focusTrapOptions={{
            escapeDeactivates: cancel,
            clickOutsideDeactivates: cancel,
            setReturnFocus: returnFocus,
          }}
        >
          <div className="mrpr-root" style={pluginRootStyle()}>
            <Dialog
              role="dialog"
              aria-modal="true"
              aria-labelledby={titleId}
              aria-describedby={bodyId}
              className="mrpr-dialog"
            >
              <p id={titleId} className="mrpr-dialog-title">
                {t('actions.deleteTitle', { branch })}
              </p>
              <p id={bodyId} className="mrpr-dialog-body">
                {t('actions.deleteBody', { branch, repo: repository })}
              </p>
              <div className="mrpr-dialog-actions">
                <button type="button" className="mrpr-button" onClick={onCancel}>
                  {t('actions.cancel')}
                </button>
                <button
                  type="button"
                  className="mrpr-button mrpr-button-danger"
                  onClick={onConfirm}
                >
                  {t('actions.deleteBranch')}
                </button>
              </div>
            </Dialog>
          </div>
        </FocusTrap>
      </OverlayCenter>
    </Overlay>
  );
}
