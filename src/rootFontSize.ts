// The root font size in px, which the client's page zoom scales (`font-size: 150%` on the root
// element). Pierre lays out its diffs and its tree from row heights in px, so the parts sized in
// rem tell it theirs in this size.
import { useSyncExternalStore } from 'react';

export function rootFontSize(): number {
  return parseFloat(getComputedStyle(document.documentElement).fontSize) || 16;
}

function subscribe(listener: () => void): () => void {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributeFilter: ['style', 'class'] });
  return () => observer.disconnect();
}

/** The root font size, again whenever the root's style or class changes it. */
export function useRootFontSize(): number {
  return useSyncExternalStore(subscribe, rootFontSize);
}
