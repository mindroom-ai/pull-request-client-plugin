// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/PullRequestCodeTab.tsx at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// The Code tab's diff options in one menu, for a toolbar too narrow for their own buttons: hide
// whitespace changes, wrap lines, and the stacked or split layout.
import { useEffect, useRef, useState, type MouseEvent } from 'react';
import FocusTrap from 'focus-trap-react';
import type { RectCords } from 'folds';
import { Settings2 } from 'lucide-react';
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { IconButton, IconTooltip, Menu, PopOut } from '@mindroom/client-sdk/ui';
import type { CodePrefs } from '../diff/codePrefs';
import { pluginRootStyle } from '../theme';
import { MenuOption } from './CommitSelector';

export function DiffOptionsMenu({
  prefs,
  onChange,
}: {
  prefs: CodePrefs;
  onChange: (change: Partial<CodePrefs>) => void;
}) {
  const t = usePluginTranslation('pull-requests');
  const [anchor, setAnchor] = useState<RectCords>();
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  // Set when a choice or Escape closes the menu, which then gives the focus back to its button.
  // That waits until the menu is gone: while its focus trap is active, the trap takes the focus
  // back. A click outside leaves the focus where it went.
  const refocus = useRef(false);
  useEffect(() => {
    if (anchor !== undefined || !refocus.current) return;
    refocus.current = false;
    buttonRef.current?.focus();
  }, [anchor]);
  const label = t('code.diffOptions');

  // Escape and a click outside close it, as the app's own menus do.
  const close = () => {
    setAnchor(undefined);
    return true;
  };
  // A layout is one choice of two, so choosing it closes the menu; the switches leave it open.
  const chooseLayout = (diffStyle: CodePrefs['diffStyle']) => {
    refocus.current = true;
    setAnchor(undefined);
    onChange({ diffStyle });
  };

  return (
    <>
      <IconTooltip label={label} align="End">
        {(triggerRef) => (
          <IconButton
            ref={(node: HTMLButtonElement | null) => {
              triggerRef(node);
              buttonRef.current = node;
            }}
            size="300"
            radii="300"
            aria-label={label}
            aria-haspopup="menu"
            aria-expanded={anchor !== undefined}
            onClick={(event: MouseEvent<HTMLButtonElement>) =>
              setAnchor(anchor ? undefined : event.currentTarget.getBoundingClientRect())
            }
          >
            <Settings2 aria-hidden className="mrpr-button-icon" />
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
              clickOutsideDeactivates: close,
              escapeDeactivates: () => {
                refocus.current = true;
                return close();
              },
            }}
          >
            <Menu aria-label={label}>
              <div
                className="mrpr-root mrpr-commit-menu mrpr-options-menu"
                style={pluginRootStyle()}
              >
                <MenuOption
                  role="menuitemcheckbox"
                  checked={prefs.ignoreWhitespace}
                  onSelect={() => onChange({ ignoreWhitespace: !prefs.ignoreWhitespace })}
                >
                  {t('code.hideWhitespace')}
                </MenuOption>
                <MenuOption
                  role="menuitemcheckbox"
                  checked={prefs.wrap}
                  onSelect={() => onChange({ wrap: !prefs.wrap })}
                >
                  {t('code.wrapLines')}
                </MenuOption>
                <div role="separator" className="mrpr-menu-separator" />
                <MenuOption
                  checked={prefs.diffStyle === 'unified'}
                  onSelect={() => chooseLayout('unified')}
                >
                  {t('code.stacked')}
                </MenuOption>
                <MenuOption
                  checked={prefs.diffStyle === 'split'}
                  onSelect={() => chooseLayout('split')}
                >
                  {t('code.split')}
                </MenuOption>
              </div>
            </Menu>
          </FocusTrap>
        }
      />
    </>
  );
}
