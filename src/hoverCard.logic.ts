// What a pull request chip's hover card works out before it draws: where it goes on screen, the
// labels it shows and the reviewers it lists.
import { latestReviewOutcomes, type ReviewOutcome } from './detail/detail.logic';
import type { Actor, Review } from './github';

type Box = { left: number; top: number; right: number; bottom: number };

/** Where a fixed card goes, in pixels from the viewport's edges, and the height it may take. */
export type HoverCardPlacement = { top?: number; bottom?: number; left: number; maxHeight: number };

/**
 * The card's place by its chip (`anchor`): below a chip in the upper half of the viewport, above
 * one in the lower half, `gap` away from it. It holds to its top edge below the chip and to its
 * bottom edge above it, so content that arrives later grows it away from the chip, and it may be
 * as tall as the room there, less `margin`. It lines up with the chip's start (its right end on a
 * right-to-left page) and stays `margin` inside the viewport's sides.
 */
export function hoverCardPlacement({
  anchor,
  card,
  viewport,
  gap,
  margin,
  rightToLeft,
}: {
  anchor: Box;
  card: { width: number; height: number };
  viewport: { width: number; height: number };
  gap: number;
  margin: number;
  rightToLeft: boolean;
}): HoverCardPlacement {
  const start = rightToLeft ? anchor.right - card.width : anchor.left;
  const left = Math.max(margin, Math.min(start, viewport.width - card.width - margin));
  const below = (anchor.top + anchor.bottom) / 2 <= viewport.height / 2;
  if (below) {
    const top = anchor.bottom + gap;
    return { top, left, maxHeight: viewport.height - top - margin };
  }
  return {
    bottom: viewport.height - anchor.top + gap,
    left,
    maxHeight: anchor.top - gap - margin,
  };
}

const SHOWN_LABELS = 5;

/** The labels the card shows, five at most, and the count of the rest. */
export function splitLabels<T>(labels: readonly T[]): { shown: T[]; more: number } {
  return { shown: labels.slice(0, SHOWN_LABELS), more: Math.max(0, labels.length - SHOWN_LABELS) };
}

// GitHub's login casing varies between its lists.
const loginKey = (login: string) => login.toLowerCase();

/**
 * The reviewers the card lists: each one's latest verdict (`latestReviewOutcomes`), and those
 * asked for a review that is still to come. A reviewer asked again after a verdict is pending.
 */
export function hoverCardReviewers(
  reviews: Review[],
  headSha: string,
  requested: Actor[]
): { verdicts: ReviewOutcome[]; pending: Actor[] } {
  const asked = new Set(requested.map((actor) => loginKey(actor.login)));
  const verdicts = latestReviewOutcomes(reviews, headSha).filter(
    (entry) => !entry.actor || !asked.has(loginKey(entry.actor.login))
  );
  return { verdicts, pending: requested };
}
