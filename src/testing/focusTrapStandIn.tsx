// A stand-in for focus-trap-react in tests, for menus that close and give the focus back. Like the
// real trap, while it is mounted it takes back the focus that leaves it, to the element last
// focused inside it; the options it was last given are there for a test to call its Escape path.
import { useEffect, useRef, type ReactNode } from 'react';

type TrapOptions = {
  escapeDeactivates?: () => boolean;
  clickOutsideDeactivates?: () => boolean;
};

let lastOptions: TrapOptions | undefined;

/** The options of the trap rendered last. */
export const trapOptions = (): TrapOptions => {
  if (!lastOptions) throw new Error('No focus trap rendered');
  return lastOptions;
};

export function FocusTrapStandIn({
  children,
  focusTrapOptions,
}: {
  children: ReactNode;
  focusTrapOptions?: TrapOptions;
}) {
  lastOptions = focusTrapOptions;
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let inside: HTMLElement | null = null;
    const onFocusIn = (event: FocusEvent) => {
      const target = event.target as HTMLElement;
      if (ref.current?.contains(target)) inside = target;
      else inside?.focus();
    };
    document.addEventListener('focusin', onFocusIn, true);
    return () => document.removeEventListener('focusin', onFocusIn, true);
  }, []);
  return <div ref={ref}>{children}</div>;
}
