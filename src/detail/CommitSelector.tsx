// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab's choice of what the diffs show: All commits, or one commit of the pull request.
// Its menu lists the commits newest first, ten at a time.
import { useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react';
import FocusTrap from 'focus-trap-react';
import type { RectCords } from 'folds';
import { Check, ChevronDown } from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { Menu, PopOut } from '@mindroom/client-sdk/ui';
import type { Commit } from '../github';
import { pluginRootStyle } from '../theme';

const COMMIT_PAGE_SIZE = 10;

export function CommitSelector({
  commits,
  commit,
  onCommitChange,
}: {
  commits: Commit[];
  /** The chosen commit's SHA; undefined is All commits. */
  commit: string | undefined;
  onCommitChange: (sha: string | undefined) => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const [anchor, setAnchor] = useState<RectCords>();
  const [visibleCount, setVisibleCount] = useState(COMMIT_PAGE_SIZE);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // The first row "Show more" brought in, which takes the focus from it.
  const focusRow = useRef<number>();
  useEffect(() => {
    if (focusRow.current === undefined) return;
    menuRef.current
      ?.querySelectorAll<HTMLElement>('[role="menuitemradio"]')
      [focusRow.current]?.focus();
    focusRow.current = undefined;
  }, [visibleCount]);

  // Newest first, by the moment each was committed.
  const ordered = [...commits].sort(
    (left, right) => Date.parse(right.committedAt) - Date.parse(left.committedAt)
  );
  const headline = (entry: Commit) => entry.headline || t('timeline.untitledCommit');
  const selected = ordered.find((entry) => entry.sha === commit);
  const label = selected ? headline(selected) : t('code.allCommits');
  const left = ordered.length - visibleCount;

  // Escape and a click outside close it, as the app's own menus do.
  const close = () => {
    setAnchor(undefined);
    return true;
  };
  const choose = (sha: string | undefined) => {
    setAnchor(undefined);
    onCommitChange(sha);
    triggerRef.current?.focus();
  };

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className="mrpr-commit-trigger"
        aria-label={t('code.scope', { label })}
        aria-haspopup="menu"
        aria-expanded={anchor !== undefined}
        onClick={(event: MouseEvent<HTMLButtonElement>) =>
          setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect())
        }
      >
        <span className="mrpr-truncate">{label}</span>
        <ChevronDown aria-hidden className="mrpr-icon mrpr-shrink-0" />
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
              returnFocusOnDeactivate: false,
              clickOutsideDeactivates: close,
              escapeDeactivates: close,
            }}
          >
            <Menu ref={menuRef} aria-label={t('code.commitsLabel')}>
              <div className="mrpr-root mrpr-commit-menu" style={pluginRootStyle()}>
                <CommitOption checked={selected === undefined} onSelect={() => choose(undefined)}>
                  <span className="mrpr-truncate">{t('code.allCommits')}</span>
                </CommitOption>
                {ordered.slice(0, visibleCount).map((entry) => (
                  <CommitOption
                    key={entry.sha}
                    checked={entry === selected}
                    title={headline(entry)}
                    onSelect={() => choose(entry.sha)}
                  >
                    <span className="mrpr-truncate">{headline(entry)}</span>
                    <code className="mrpr-commit-sha">{entry.sha.slice(0, 7)}</code>
                  </CommitOption>
                ))}
                {left > 0 ? (
                  <button
                    type="button"
                    role="menuitem"
                    className="mrpr-commit-option mrpr-commit-more"
                    onClick={() => {
                      // Row 0 is All commits.
                      focusRow.current = visibleCount + 1;
                      setVisibleCount(visibleCount + COMMIT_PAGE_SIZE);
                    }}
                  >
                    {t('code.showMoreCommits', { count: left })}
                  </button>
                ) : null}
              </div>
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}

function CommitOption({
  checked,
  title,
  onSelect,
  children,
}: {
  checked: boolean;
  title?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      role="menuitemradio"
      aria-checked={checked}
      className="mrpr-commit-option"
      title={title}
      onClick={onSelect}
    >
      <Check aria-hidden className={`mrpr-icon mrpr-shrink-0${checked ? '' : ' mrpr-invisible'}`} />
      {children}
    </button>
  );
}
