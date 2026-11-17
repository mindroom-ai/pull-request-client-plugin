import { describe, expect, it } from 'vitest';
import {
  TREE_DEFAULT_WIDTH,
  TREE_MIN_WIDTH,
  clampTreeWidth,
  steppedTreeWidth,
  treeMaxWidth,
} from './treeWidth.logic';

describe('treeMaxWidth', () => {
  it('leaves the diffs 256px, up to 560px, and never less than the narrowest', () => {
    expect(treeMaxWidth(640)).toBe(384);
    expect(treeMaxWidth(1000)).toBe(560);
    expect(treeMaxWidth(816)).toBe(560);
    expect(treeMaxWidth(400)).toBe(TREE_MIN_WIDTH);
    expect(treeMaxWidth(0)).toBe(TREE_MIN_WIDTH);
  });
});

describe('clampTreeWidth', () => {
  it('keeps a width within the bounds and clamps one outside them', () => {
    expect(clampTreeWidth(300, 560)).toBe(300);
    expect(clampTreeWidth(100, 560)).toBe(TREE_MIN_WIDTH);
    expect(clampTreeWidth(500, 384)).toBe(384);
  });

  it('shows the default for a width that is not a number', () => {
    expect(clampTreeWidth(Number.NaN, 560)).toBe(TREE_DEFAULT_WIDTH);
    expect(clampTreeWidth(Number.POSITIVE_INFINITY, 560)).toBe(TREE_DEFAULT_WIDTH);
    expect(clampTreeWidth(Number.NaN, TREE_MIN_WIDTH)).toBe(TREE_MIN_WIDTH);
  });
});

describe('steppedTreeWidth', () => {
  it('steps 16px with the arrows, toward the diffs widening it', () => {
    expect(steppedTreeWidth('ArrowRight', 240, 560, false)).toBe(256);
    expect(steppedTreeWidth('ArrowLeft', 240, 560, false)).toBe(224);
    expect(steppedTreeWidth('ArrowLeft', 240, 560, true)).toBe(256);
    expect(steppedTreeWidth('ArrowRight', 240, 560, true)).toBe(224);
  });

  it('stops at the bounds', () => {
    expect(steppedTreeWidth('ArrowRight', 550, 560, false)).toBe(560);
    expect(steppedTreeWidth('ArrowLeft', 200, 560, false)).toBe(TREE_MIN_WIDTH);
  });

  it('Home and End go to the narrowest and the widest', () => {
    expect(steppedTreeWidth('Home', 300, 560, false)).toBe(TREE_MIN_WIDTH);
    expect(steppedTreeWidth('End', 300, 400, false)).toBe(400);
  });

  it('ignores other keys', () => {
    expect(steppedTreeWidth('ArrowUp', 240, 560, false)).toBeNull();
    expect(steppedTreeWidth('Enter', 240, 560, false)).toBeNull();
  });
});
