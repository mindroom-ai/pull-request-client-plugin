// Ported from T3 Code (https://github.com/pingdotgg/t3code, apps/web/src/components/pullRequest/useInlineActionConfirm.ts at 428d3659), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
// A two-click confirm: the first click arms a button, the second on the same button confirms.
// Arming ends after 3 s, on a pointerdown outside the button, on Escape, when the window loses
// focus, when the button loses focus, or when the scope (the pull request) changes.
import { useState, type MouseEvent } from 'react';

interface ArmedAction {
  readonly scopeKey: string;
  readonly action: string;
  readonly element: HTMLElement;
  // Stable per arming, so React attaches it once. Detaching it (disarm, scope change, or the
  // armed element unmounting) removes the listeners and disarms.
  readonly ref: (node: HTMLElement | null) => (() => void) | undefined;
}

export function useInlineConfirm(scopeKey: string) {
  const [armed, setArmed] = useState<ArmedAction | null>(null);
  if (armed !== null && armed.scopeKey !== scopeKey) setArmed(null);
  const active = armed?.scopeKey === scopeKey ? armed : null;

  const arm = (action: string, element: HTMLElement) => {
    // T3 returns the cleanup from the ref, which React 19 runs on detach. React 18 warns about a
    // returned function and calls the ref with null instead, as React 19 also does for a ref that
    // returns nothing, so the ref returns nothing and cleans up on null.
    let detach: (() => void) | undefined;
    const entry: ArmedAction = {
      scopeKey,
      action,
      element,
      ref: (node) => {
        if (node === null) {
          detach?.();
          detach = undefined;
          return undefined;
        }
        const controller = new AbortController();
        const { signal } = controller;
        const release = () => setArmed((current) => (current === entry ? null : current));
        document.addEventListener(
          'pointerdown',
          (event) => {
            if (event.target instanceof Node && !node.contains(event.target)) release();
          },
          { capture: true, signal }
        );
        window.addEventListener(
          'keydown',
          (event) => {
            if (event.key !== 'Escape') return;
            event.preventDefault();
            event.stopPropagation();
            release();
          },
          { capture: true, signal }
        );
        window.addEventListener('blur', release, { signal });
        const timeout = window.setTimeout(release, 3000);
        detach = () => {
          controller.abort();
          window.clearTimeout(timeout);
          release();
        };
        return undefined;
      },
    };
    setArmed(entry);
  };

  return {
    isArmed: (action: string) => active?.action === action,
    props: (action: string, onConfirm: () => void) => ({
      ref: active?.action === action ? active.ref : undefined,
      onClick: (event: MouseEvent<HTMLElement>) => {
        if (active?.action === action && active.element === event.currentTarget) {
          setArmed(null);
          onConfirm();
        } else {
          arm(action, event.currentTarget);
        }
      },
      onBlur: () => setArmed(null),
    }),
  };
}
