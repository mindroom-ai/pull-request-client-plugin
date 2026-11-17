import { describe, expect, it } from 'vitest';
import { middleTruncate } from './middleTruncate';

describe('middleTruncate', () => {
  it('keeps a short text', () => expect(middleTruncate('main', 24)).toBe('main'));

  it('keeps the start and the end of a long one', () =>
    expect(middleTruncate('feature/thread-details-hover-card', 20)).toBe('feature/th…over-card'));

  it('cuts between code points', () =>
    expect(middleTruncate('🌳'.repeat(30), 5)).toBe('🌳🌳…🌳🌳'));
});
