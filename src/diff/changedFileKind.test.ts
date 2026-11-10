// Ported from T3 Code (https://github.com/pingdotgg/t3code, packages/shared/src/changedFileKind.test.ts at 8ab427c6), MIT, Copyright (c) 2026 T3 Tools Inc. See NOTICE.
import { describe, expect, it } from 'vitest';

import { changedFileKind, isTestFile } from './changedFileKind';

describe('changedFileKind', () => {
  it.each([
    ['src/contest.py', 'code'],
    ['test/fixtures/pr.json', 'test'],
    ['pnpm-lock.yaml', 'generated'],
    ['convex/_generated/api.d.ts', 'generated'],
    ['src/agent.eval.ts', 'test'],
    ['evals/title-generation.ts', 'test'],
    ['README.md', 'docs'],
    ['tests/README.md', 'test'],
  ] as const)('%s is %s', (path, kind) => {
    expect(changedFileKind(path)).toBe(kind);
  });
});

describe('isTestFile', () => {
  it('counts tests and their mocks, fixtures and snapshots as tests', () => {
    expect(isTestFile('src/a.test.ts')).toBe(true);
    expect(isTestFile('src/__mocks__/a.ts')).toBe(true);
    expect(isTestFile('src/__snapshots__/a.test.ts.snap')).toBe(true);
    expect(isTestFile('src/a.ts')).toBe(false);
    expect(isTestFile('docs/testing.md')).toBe(false);
  });
});
