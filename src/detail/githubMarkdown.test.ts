import { describe, expect, it } from 'vitest';
import type { GitHubBodyMeta } from '../githubBody';
import { prepareGitHubMarkdown } from './githubMarkdown';

const UUID = '11111111-2222-3333-4444-555555555555';
const OTHER_UUID = '99999999-2222-3333-4444-555555555555';
const SHA = '0123456789abcdef0123456789abcdef01234567';
const SHA_A = 'abcdef1aaaa00000000000000000000000000000';
const SHA_B = 'abcdef1bbbb00000000000000000000000000000';

const META: GitHubBodyMeta = {
  links: {
    '#42': 'https://github.com/acme/widgets/issues/42',
    'acme/widgets#99': 'https://github.com/acme/widgets/pull/99',
    'gh-7': 'https://github.com/acme/widgets/discussions/7',
    '@alice': 'https://github.com/alice',
    '@acme': 'https://github.com/acme',
    '@acme/core': 'https://github.com/orgs/acme/teams/core',
  },
  commits: {
    [SHA]: `https://github.com/acme/widgets/commit/${SHA}`,
    [`acme/widgets@${SHA}`]: `https://github.com/acme/widgets/commit/${SHA}`,
    [SHA_A]: `https://github.com/acme/widgets/commit/${SHA_A}`,
    [SHA_B]: `https://github.com/acme/widgets/commit/${SHA_B}`,
  },
  videos: { [UUID]: { label: 'demo [before].mp4' } },
};

describe('prepareGitHubMarkdown', () => {
  it('strips single-line and multi-line HTML comments and cleans excess blank lines', () => {
    expect(prepareGitHubMarkdown('')).toBeNull();
    expect(prepareGitHubMarkdown('<!-- auto-generated note -->')).toBeNull();
    expect(prepareGitHubMarkdown('  <!-- a -->\n<!--\nb\n-->\n ')).toBeNull();
    expect(prepareGitHubMarkdown('<!-- auto-generated note -->\r\n\r\nNeeds a test.')).toBe(
      'Needs a test.'
    );
    expect(prepareGitHubMarkdown('First.\n\n<!-- hidden -->\n\nSecond.')).toBe('First.\n\nSecond.');
    expect(prepareGitHubMarkdown('Body.\n\n<!-- trailing -->\n')).toBe('Body.');
    expect(prepareGitHubMarkdown('Hello <!-- inline --> world')).toBe('Hello  world');
  });

  it('preserves leading indentation of indented code blocks and comments inside code', () => {
    expect(prepareGitHubMarkdown('    <!-- kept -->\n    #42', META)).toBe(
      '    <!-- kept -->\n    #42'
    );
    expect(prepareGitHubMarkdown('\t<!-- kept -->', META)).toBe('\t<!-- kept -->');
    expect(prepareGitHubMarkdown('<!-- auto-generated note -->\n\n    code()', META)).toBe(
      '    code()'
    );
    expect(prepareGitHubMarkdown('```html\n<!-- kept -->\n#42 @alice\n```', META)).toBe(
      '```html\n<!-- kept -->\n#42 @alice\n```'
    );
    expect(prepareGitHubMarkdown('~~~\n<!-- kept -->\n~~~', META)).toBe('~~~\n<!-- kept -->\n~~~');
    expect(prepareGitHubMarkdown('````md\n```\n<!-- kept -->\n```\n````', META)).toBe(
      '````md\n```\n<!-- kept -->\n```\n````'
    );
    expect(prepareGitHubMarkdown('`` `<!-- kept -->` `` and `<!-- kept -->`', META)).toBe(
      '`` `<!-- kept -->` `` and `<!-- kept -->`'
    );
    // Backtick fence info strings cannot contain backticks, so this is an inline code span + #42.
    expect(prepareGitHubMarkdown('```<!-- kept -->``` and #42', META)).toBe(
      '```<!-- kept -->``` and [#42](https://github.com/acme/widgets/issues/42)'
    );
  });

  it('rewrites verified autolinks in prose and list continuations, with zero guessing', () => {
    expect(
      prepareGitHubMarkdown('Fixes #42, acme/widgets#99, GH-7; cc @alice: and @acme/core', META)
    ).toBe(
      'Fixes [#42](https://github.com/acme/widgets/issues/42), [acme/widgets#99](https://github.com/acme/widgets/pull/99), [GH-7](https://github.com/acme/widgets/discussions/7); cc [@alice](https://github.com/alice): and [@acme/core](https://github.com/orgs/acme/teams/core)'
    );
    expect(prepareGitHubMarkdown('- item\n\n    See #42', META)).toBe(
      '- item\n\n    See [#42](https://github.com/acme/widgets/issues/42)'
    );
    // Unverified refs, Matrix IDs, emails, npm scopes, and non-video URLs stay untouched.
    const untouched =
      'See #999, @bob, @alice:example.org, a@alice.com, @acme/pkg, and https://example.com/?r=#42&u=@alice&s=0123456';
    expect(prepareGitHubMarkdown(untouched, META)).toBe(untouched);
  });

  it('links unique verified commit SHAs and leaves ambiguous, cross-repo, or unverified hex alone', () => {
    expect(
      prepareGitHubMarkdown(
        `See 0123456, ${SHA}, and acme/widgets@0123456 (not other/lib@0123456 or deadbeef or @0123456:example.org)`,
        META
      )
    ).toBe(
      `See [\`0123456\`](https://github.com/acme/widgets/commit/${SHA}), [\`0123456\`](https://github.com/acme/widgets/commit/${SHA}), and [\`acme/widgets@0123456\`](https://github.com/acme/widgets/commit/${SHA}) (not other/lib@0123456 or deadbeef or @0123456:example.org)`
    );
    // Ambiguous 7-char prefix stays plain; unique 8-char prefix links.
    expect(prepareGitHubMarkdown('Compare abcdef1 vs abcdef1a', META)).toBe(
      `Compare abcdef1 vs [\`abcdef1\`](https://github.com/acme/widgets/commit/${SHA_A})`
    );
  });

  it('rewrites verified bare video URLs with escaped labels while keeping links, images, and HTML untouched', () => {
    const asset = `https://github.com/user-attachments/assets/${UUID}`;
    const legacy = `https://github.com/acme/widgets/assets/9/${UUID}`;
    expect(prepareGitHubMarkdown(`Watch (${asset}).\n${legacy}`, META)).toBe(
      `Watch ([demo \\[before\\].mp4](${asset})).\n[demo \\[before\\].mp4](${legacy})`
    );
    const keep = [
      `[see #42](${asset})`,
      `![@alice](${asset})`,
      `<${asset}>`,
      `<video src="${asset}"></video>`,
      `<a href="https://example.com">#42</a>`,
      `<code>#42</code>`,
      `[vid]: ${asset}`,
      `https://github.com/user-attachments/assets/${OTHER_UUID}`,
      String.raw`\#42 \@alice`,
    ].join('\n');
    expect(prepareGitHubMarkdown(keep, META)).toBe(keep);
  });
});
