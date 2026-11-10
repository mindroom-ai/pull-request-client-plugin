// @vitest-environment jsdom
import { usePluginTranslation } from '@mindroom/client-sdk/core';
import { renderPluginComponent } from '@mindroom/client-sdk/testing';
import { describe, expect, it } from 'vitest';
import type { CheckStatus, PullRequestCheck } from '../github';
import plugin from '../index';
import { summarizeChecks } from './detail.logic';

const run = 'https://github.com/a/b/actions/runs/12/job/34';

const check = (status: CheckStatus, url: string | null = null): PullRequestCheck => ({
  name: status,
  status,
  description: null,
  url,
  updatedAt: null,
});

const times = (n: number, status: CheckStatus, url: string | null = null) =>
  Array.from({ length: n }, () => check(status, url));

function Summaries({ lists }: { lists: PullRequestCheck[][] }) {
  const t = usePluginTranslation('pull-requests');
  return (
    <ul>
      {lists.map((checks, index) => {
        const { key, ...values } = summarizeChecks(checks);
        return <li key={index}>{t(`checks.${key}`, values)}</li>;
      })}
    </ul>
  );
}

describe('the checks summary in English', () => {
  it('reads as T3 Code writes it, for every key', async () => {
    const cases: [PullRequestCheck[], string][] = [
      [[], 'No checks reported'],
      [[check('failure'), ...times(8, 'success')], '1 of 9 failing'],
      [[...times(2, 'cancelled'), ...times(7, 'pending')], '2 of 9 failing'],
      [times(1, 'action-required', run), '1 workflow awaiting approval'],
      [times(2, 'action-required', run), '2 workflows awaiting approval'],
      [[check('action-required'), check('success')], '1 check awaiting action'],
      [times(3, 'action-required'), '3 checks awaiting action'],
      [
        [check('action-required', run), check('action-required')],
        '1 workflow and 1 check awaiting action',
      ],
      [
        [check('action-required', run), ...times(2, 'action-required')],
        '1 workflow and 2 checks awaiting action',
      ],
      [
        [...times(2, 'action-required', run), check('action-required')],
        '2 workflows and 1 check awaiting action',
      ],
      [
        [...times(2, 'action-required', run), ...times(3, 'action-required')],
        '2 workflows and 3 checks awaiting action',
      ],
      [[...times(3, 'pending'), ...times(6, 'success')], '3 of 9 running'],
      [times(9, 'success'), 'All checks have passed'],
      [[check('success'), check('skipped'), check('neutral')], '1 of 3 passing'],
    ];
    const view = await renderPluginComponent(
      <Summaries lists={cases.map(([checks]) => checks)} />,
      {
        id: 'pull-requests',
        plugin,
      }
    );
    expect([...view.container.querySelectorAll('li')].map((item) => item.textContent)).toEqual(
      cases.map(([, text]) => text)
    );
  });
});
