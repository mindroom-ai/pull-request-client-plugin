import { describe, expect, it } from 'vitest';
import { hoverCardPlacement, splitLabels } from './hoverCard.logic';

const VIEWPORT = { width: 1000, height: 800 };
const CARD = { width: 360, height: 200 };
const at = (left: number, top: number) => ({ left, top, right: left + 60, bottom: top + 20 });
const place = (anchor: ReturnType<typeof at>, rightToLeft = false, card = CARD) =>
  hoverCardPlacement({ anchor, card, viewport: VIEWPORT, gap: 4, margin: 8, rightToLeft });

describe('hoverCardPlacement', () => {
  it('opens below a chip in the upper half, as tall as the room below it', () => {
    expect(place(at(100, 100))).toEqual({ top: 124, left: 100, maxHeight: 668 });
  });

  it('opens above a chip in the lower half, as tall as the room above it', () => {
    expect(place(at(100, 600))).toEqual({ bottom: 204, left: 100, maxHeight: 588 });
  });

  it('keeps the card inside the viewport at its inline end', () => {
    expect(place(at(900, 100)).left).toBe(632);
  });

  it('lines the card up with the chip end on a right-to-left page', () => {
    expect(place(at(500, 100), true).left).toBe(200);
    expect(place(at(20, 100), true).left).toBe(8);
  });

  it('starts at the margin when the card is wider than the viewport', () => {
    expect(place(at(100, 100), false, { width: 1200, height: 200 }).left).toBe(8);
  });
});

describe('splitLabels', () => {
  const labels = (count: number) =>
    Array.from({ length: count }, (_, index) => ({ name: `l${index}`, color: '000000' }));

  it('shows five labels and counts the rest', () => {
    const { shown, more } = splitLabels(labels(7));
    expect(shown.map((label) => label.name)).toEqual(['l0', 'l1', 'l2', 'l3', 'l4']);
    expect(more).toBe(2);
  });

  it('shows all of five or fewer', () => {
    expect(splitLabels(labels(5))).toEqual({ shown: labels(5), more: 0 });
  });
});
