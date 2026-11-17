// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestDetailActions.tsx and PullRequestActionsMenu.tsx at 428d3659), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The header's actions on a pull request: its one primary control, the menu of the rest, the
// dialog that asks before a branch is deleted, and the line under the header that says what runs
// and what came of it. A viewer who cannot write to the repository, or has no token, sees none.
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
import { useChecks, useHeadBranchSha } from '../queries';
import { pluginRootStyle } from '../theme';
import { mayDeleteBranch, menuActions, primaryControl } from './actions.logic';
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

const DONE: ReadonlySet<PullRequestAction> = new Set([
  'delete-branch',
  'update-branch',
  'update-branch-rebase',
]);

export function HeaderActions({
  pullRequestRef,
  pullRequest: pr,
  actions,
}: {
  pullRequestRef: PullRequestRef;
  pullRequest: PullRequest;
  actions: Actions;
}) {
  const t = usePluginTranslation('pull-requests');
  const { repo, method, chooseMethod, pending, result, perform, dismissResult } = actions;
  const canWrite = repo?.canWrite === true;
  // The same query as the checks line, so it costs no request of its own where that one shows.
  const checks = useChecks(pullRequestRef, pr.headSha, canWrite);
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

  if (!repo || !canWrite) return null;

  const busy = pending !== null;
  const primary = primaryControl(
    pr,
    repo,
    checks.data ? checksState(checks.data.items) : undefined
  );
  const listed = menuActions(pr, repo, primary, headBranch.data);
  const showsMethods =
    pr.state === 'open' && !pr.draft && primary !== 'conflicts' && repo.mergeMethods.length > 1;
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
    const { owner, repo: name, number } = pullRequestRef;
    void queryClient.invalidateQueries({ queryKey: ['pull-requests', 'pr', owner, name, number] });
    void queryClient.invalidateQueries({ queryKey: ['pull-requests', 'repo', owner, name] });
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
  } else if (primary === 'ready') {
    primaryControlElement = (
      <button
        type="button"
        className="mrpr-button mrpr-button-primary"
        disabled={busy}
        onClick={() => perform('ready')}
      >
        {primaryLabel('ready', t('actions.ready'))}
      </button>
    );
  } else if ((primary === 'merge' || primary === 'enable-auto-merge') && method !== null) {
    const idle =
      primary === 'merge' ? t(`actions.merge.${method}`) : t('actions.autoMerge', { method });
    primaryControlElement = (
      <button
        type="button"
        className="mrpr-button mrpr-button-primary"
        disabled={busy}
        {...confirm.props(primary, () => perform(primary))}
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
            disabled={busy}
            onClick={(event: MouseEvent<HTMLButtonElement>) =>
              setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect())
            }
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
                        {repo.mergeMethods.map((option) => (
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
              </div>
            </Menu>
          </FocusTrap>
        }
      />
      <ResultLine
        pending={pending === primaryAction ? null : pending}
        result={result}
        onDismiss={dismissResult}
      />
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
 * What runs when no control on screen says so, and what came of the last action: a failure with
 * why, or a success that nothing else on screen shows. The status region stays drawn while it
 * has nothing to say, as some screen readers announce only a change in one already there.
 */
function ResultLine({
  pending,
  result,
  onDismiss,
}: {
  pending: PullRequestAction | null;
  result: ActionResult | null;
  onDismiss: () => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const shown =
    pending === null && result !== null && (result.outcome === 'failed' || DONE.has(result.action))
      ? result
      : null;
  let content: ReactNode = null;
  if (pending !== null) {
    content = t(`actions.pending.${pending}`);
  } else if (shown !== null) {
    const dismiss = t('actions.dismiss');
    let text: ReactNode;
    if (shown.outcome === 'done') {
      text = <span>{t(`actions.done.${shown.action}`)}</span>;
    } else {
      const { kind, detail } = shown.error;
      // A refusal is GitHub's reason alone. Without access the hint comes first, then GitHub's
      // reason when it gave one: an organization that has not allowed the token, or a limit,
      // reads as that and not only as missing access.
      const hint = kind === 'refused' ? null : t(`actions.hint.${kind}`);
      const why = [hint, kind === 'refused' || kind === 'noAccess' ? detail : null]
        .filter(Boolean)
        .join(' ');
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
  return (
    <div role="status" className={content === null ? 'mrpr-sr-only' : 'mrpr-action-result'}>
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
