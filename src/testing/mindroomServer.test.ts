import { describe, expect, it } from 'vitest';
import { allowedPath } from './mindroomServer';

describe('allowedPath', () => {
  it.each([
    '/graphql',
    '/repos/o/r',
    '/repos/o/r/pulls/1/files?per_page=100&page=2',
    '/repos/o/r/compare/release/1.0...abc123',
    '/repos/o/r/commits/a%3Fb',
  ])('takes %s', (path) => {
    expect(allowedPath(path)).toBe(true);
  });

  it.each([
    '/repos/o',
    '/user',
    '/graphql/x',
    '/repos/o/r//pulls',
    '/repos/o/r/../x',
    '/repos/o/r/%2e%2e/x',
    '/repos/o/r/compare/release%2F1.0...abc',
    '/repos/o/r/a%5Cb',
    '/repos/o/r/a%0Ab',
    '/repos/o/r/a b',
    `/repos/o/r/${'a'.repeat(4096)}`,
  ])('refuses %s', (path) => {
    expect(allowedPath(path)).toBe(false);
  });
});
