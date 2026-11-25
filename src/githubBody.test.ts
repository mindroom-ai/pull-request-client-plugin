import { describe, expect, it } from 'vitest';
import { extractGitHubBodyMeta } from './githubBody';

const UUID = '11111111-2222-3333-4444-555555555555';
const UUID2 = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const PR_SHA = 'fedcba9876543210fedcba9876543210fedcba98';

describe('extractGitHubBodyMeta', () => {
  it('returns empty metadata when body_html is absent or non-string', () => {
    for (const input of [undefined, null, 42, '']) {
      expect(extractGitHubBodyMeta(input)).toEqual({ links: {}, commits: {}, videos: {} });
    }
  });

  it('extracts verified issue, PR, discussion, mention, and commit autolinks', () => {
    const html = [
      '<p><a class="issue-link js-issue-link" href="https://github.com/acme/widgets/issues/42">#42</a>',
      '<a class="issue-link" href="https://github.com/acme/widgets/pull/7">acme/widgets#7</a>',
      '<a class="issue-link" href="https://github.com/acme/widgets/discussions/9">GH-9</a>',
      '<a class="user-mention notranslate" href="https://github.com/alice">@Alice</a>',
      '<a class="team-mention" href="https://github.com/orgs/acme/teams/core">@acme/core</a>',
      `<a class="commit-link" href="https://github.com/acme/widgets/commit/${SHA}"><tt>0123456</tt></a>`,
      `<a class="commit-link" href="https://github.com/acme/widgets/pull/7/commits/${PR_SHA}"><code>fedcba9</code></a></p>`,
    ].join(' ');
    expect(extractGitHubBodyMeta(html)).toEqual({
      links: {
        '#42': 'https://github.com/acme/widgets/issues/42',
        'acme/widgets#7': 'https://github.com/acme/widgets/pull/7',
        'gh-9': 'https://github.com/acme/widgets/discussions/9',
        '@alice': 'https://github.com/alice',
        '@acme/core': 'https://github.com/orgs/acme/teams/core',
      },
      commits: {
        [SHA]: `https://github.com/acme/widgets/commit/${SHA}`,
        [`acme/widgets@${SHA}`]: `https://github.com/acme/widgets/commit/${SHA}`,
        [PR_SHA]: `https://github.com/acme/widgets/pull/7/commits/${PR_SHA}`,
        [`acme/widgets@${PR_SHA}`]: `https://github.com/acme/widgets/pull/7/commits/${PR_SHA}`,
      },
      videos: {},
    });
  });

  it('extracts video attachment labels from details blocks, including nested details and fallbacks', () => {
    const html = [
      '<details><summary>Unrelated log</summary><p>no video</p></details>',
      `<details><summary>Outer</summary><details open=""><summary><svg><path d="M0 0"></path></svg> <span>demo-before.mp4</span></summary>`,
      `<video src="https://private-user-images.githubusercontent.com/1/2-${UUID}.mp4?jwt=x&amp;v=1" controls></video></details></details>`,
      `<details><summary><svg></svg></summary><video src="https://private-user-images.githubusercontent.com/1/2.mp4" data-canonical-src="https://github.com/user-attachments/assets/${UUID2}"></video></details>`,
    ].join('');
    expect(extractGitHubBodyMeta(html).videos).toEqual({
      [UUID]: { label: 'demo-before.mp4' },
      [UUID2]: { label: 'video' },
    });
  });

  it('rejects hostile, non-GitHub, unclassed, credentialed, or invalid commit links and videos', () => {
    const html = [
      '<a class="issue-link" href="http://github.com/acme/widgets/issues/1">#1</a>',
      '<a class="issue-link" href="https://evil.example/acme/widgets/issues/2">#2</a>',
      '<a class="issue-link" href="https://github.com.evil.example/acme/widgets/issues/3">#3</a>',
      '<a class="user-mention" href="https://user:pass@github.com/alice">@alice</a>',
      '<a class="user-mention" href="javascript:alert(1)">@bob</a>',
      '<a class="issue-link" href="https://github.com/acme/widgets/issues/4">__proto__</a>',
      '<a href="https://github.com/acme/widgets/issues/5">#5</a>',
      '<a class="commit-link" href="https://github.com/acme/widgets/commit/0123456">0123456</a>',
      `<details><summary>bad.mp4</summary><video src="https://evil.example/assets/${UUID}"></video></details>`,
      `<details><summary>cred.mp4</summary><video src="https://u:p@github.com/user-attachments/assets/${UUID2}"></video></details>`,
    ].join('');
    const meta = extractGitHubBodyMeta(html);
    expect(meta).toEqual({ links: {}, commits: {}, videos: {} });
    expect(Object.hasOwn(meta.links, '__proto__')).toBe(false);
  });
});
