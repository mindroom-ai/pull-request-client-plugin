import { describe, expect, it } from 'vitest';
import type { GitHubBodyMeta } from '../githubBody';
import { linkifyGitHubHtml, stripGitHubHtmlComments } from './prepareGitHubMarkdown';

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
  videos: { [UUID]: { label: 'demo [before] & <after>.mp4' } },
};

const a = (href: string, inner: string) =>
  `<a href="${href}" target="_blank" rel="noreferrer noopener">${inner}</a>`;

describe('stripGitHubHtmlComments', () => {
  it('strips single-line and multi-line HTML comments and preserves visible text and paragraph breaks', () => {
    expect(stripGitHubHtmlComments('')).toBeNull();
    expect(stripGitHubHtmlComments('<!-- auto-generated note -->')).toBeNull();
    expect(stripGitHubHtmlComments('  <!-- a -->\n<!--\nb\n-->\n ')).toBeNull();
    expect(stripGitHubHtmlComments('<!-- auto-generated note -->\r\n\r\nNeeds a test.')).toBe(
      'Needs a test.'
    );
    expect(stripGitHubHtmlComments('First.\n\n<!-- hidden -->\n\nSecond.')).toBe(
      'First.\n\nSecond.'
    );
    expect(stripGitHubHtmlComments('Body.\n\n<!-- trailing -->\n')).toBe('Body.');
    expect(stripGitHubHtmlComments('Hello <!-- inline --> world')).toBe('Hello  world');
    expect(stripGitHubHtmlComments('<!-- a --> <!-- b --> Keep this text.\n<!-- c -->')).toBe(
      'Keep this text.'
    );
    expect(stripGitHubHtmlComments('para1\n<!-- c -->\npara2')).toBe('para1\n\npara2');
    expect(stripGitHubHtmlComments('para1\n<!-- c1 -->\n<!-- c2 -->\npara2')).toBe(
      'para1\n\npara2'
    );
    expect(stripGitHubHtmlComments('    code1\n<!-- c -->\n    code2')).toBe(
      '    code1\n\n    code2'
    );
    expect(stripGitHubHtmlComments('Keep <!-- unclosed comment')).toBe(
      'Keep <!-- unclosed comment'
    );
  });

  it('preserves comments inside fenced code, indented code, lists, blockquotes, and inline code spans', () => {
    expect(stripGitHubHtmlComments('    <!-- kept -->\n    #42')).toBe(
      '    <!-- kept -->\n    #42'
    );
    expect(stripGitHubHtmlComments('\t<!-- kept -->')).toBe('\t<!-- kept -->');
    expect(stripGitHubHtmlComments('<!-- auto-generated note -->\n\n    code()')).toBe(
      '    code()'
    );
    expect(stripGitHubHtmlComments('```html\n<!-- kept -->\n#42 @alice\n```')).toBe(
      '```html\n<!-- kept -->\n#42 @alice\n```'
    );
    expect(stripGitHubHtmlComments('~~~\n<!-- kept -->\n~~~')).toBe('~~~\n<!-- kept -->\n~~~');
    expect(stripGitHubHtmlComments('````md\n```\n<!-- kept -->\n```\n````')).toBe(
      '````md\n```\n<!-- kept -->\n```\n````'
    );
    expect(stripGitHubHtmlComments('`` `<!-- kept -->` `` and `<!-- kept -->`')).toBe(
      '`` `<!-- kept -->` `` and `<!-- kept -->`'
    );
    // Backtick fence info strings cannot contain backticks, so this is an inline code span.
    expect(stripGitHubHtmlComments('```<!-- kept -->``` and <!-- stripped -->end')).toBe(
      '```<!-- kept -->``` and end'
    );
    // List-indented code, blockquote-indented code, and fenced code inside containers.
    expect(stripGitHubHtmlComments('- Example:\n\n      <!-- keep -->')).toBe(
      '- Example:\n\n      <!-- keep -->'
    );
    expect(stripGitHubHtmlComments('>     <!-- keep -->')).toBe('>     <!-- keep -->');
    expect(stripGitHubHtmlComments('> - Example:\n>\n>       <!-- keep -->')).toBe(
      '> - Example:\n>\n>       <!-- keep -->'
    );
    expect(stripGitHubHtmlComments('> ```html\n> <!-- keep -->\n> ```\n<!-- drop -->')).toBe(
      '> ```html\n> <!-- keep -->\n> ```'
    );
    expect(stripGitHubHtmlComments('- item\n  ```\n  <!-- keep -->\n  ```\n<!-- drop -->')).toBe(
      '- item\n  ```\n  <!-- keep -->\n  ```'
    );
    expect(
      stripGitHubHtmlComments('- ```html\n  <div><!-- slot --></div>\n  ```\n<!-- drop -->')
    ).toBe('- ```html\n  <div><!-- slot --></div>\n  ```');
    expect(stripGitHubHtmlComments('1. ~~~html\n   <!-- keep -->\n   ~~~\n<!-- drop -->')).toBe(
      '1. ~~~html\n   <!-- keep -->\n   ~~~'
    );
    expect(stripGitHubHtmlComments('10. ~~~html\n    <!-- keep -->\n    ~~~\n<!-- drop -->')).toBe(
      '10. ~~~html\n    <!-- keep -->\n    ~~~'
    );
    // Backslash-escaped backtick does not open a code span.
    expect(stripGitHubHtmlComments(String.raw`\`<!-- drop -->\``)).toBe(
      String.raw`\`` + String.raw`\``
    );
    // Multi-line inline code span protects inline comments, while block comments break paragraphs.
    expect(stripGitHubHtmlComments('Here is `inline\nfoo <!-- kept --> bar\ncode`!')).toBe(
      'Here is `inline\nfoo <!-- kept --> bar\ncode`!'
    );
    expect(stripGitHubHtmlComments('Here is `inline\n<!-- drop -->\ncode`!')).toBe(
      'Here is `inline\n\ncode`!'
    );
    expect(stripGitHubHtmlComments('# Heading `unclosed\nfoo <!-- drop --> `bar')).toBe(
      '# Heading `unclosed\nfoo  `bar'
    );
  });
});

describe('linkifyGitHubHtml', () => {
  it('returns html unchanged when bodyMeta is absent or empty', () => {
    const html = '<p>Fixes #42 and @alice</p>';
    expect(linkifyGitHubHtml(html)).toBe(html);
    expect(linkifyGitHubHtml(html, { links: {}, commits: {}, videos: {} })).toBe(html);
  });

  it('links verified issues, PRs, discussions, and mentions in eligible HTML text only', () => {
    expect(
      linkifyGitHubHtml('<p>Fixes #42, acme/widgets#99, GH-7; cc @alice: and @acme/core.</p>', META)
    ).toBe(
      `<p>Fixes ${a(META.links['#42']!, '#42')}, ${a(META.links['acme/widgets#99']!, 'acme/widgets#99')}, ${a(META.links['gh-7']!, 'GH-7')}; cc ${a(META.links['@alice']!, '@alice')}: and ${a(META.links['@acme/core']!, '@acme/core')}.</p>`
    );

    // Shortcut references and existing links/code/pre stay untouched; plain text gets linked.
    expect(
      linkifyGitHubHtml(
        '<p><a href="https://example.org/spec">#42</a> and #42 and <code>#42</code> and <pre><span>@alice</span></pre></p>',
        META
      )
    ).toBe(
      `<p><a href="https://example.org/spec">#42</a> and ${a(META.links['#42']!, '#42')} and <code>#42</code> and <pre><span>@alice</span></pre></p>`
    );

    // HTML numeric entities, dotted/regular Matrix IDs, emails, unverified refs, and non-video URLs stay untouched.
    const untouched =
      '<p>Entity &#42; and &#x2a;, #999, @bob, @alice.dev:example.org, @alice:example.org, a@alice.com, @acme/pkg, and https://example.com/?r=#42&amp;u=@alice&amp;s=0123456</p>';
    expect(linkifyGitHubHtml(untouched, META)).toBe(untouched);

    // Non-anchor tags starting with "a" (e.g. <abbr>) and attributes containing ">" are parsed accurately.
    expect(
      linkifyGitHubHtml(
        '<p><abbr title="issue">#42</abbr> <a title="a > b" href="https://example.org">#42</a></p>',
        META
      )
    ).toBe(
      `<p><abbr title="issue">${a(META.links['#42']!, '#42')}</abbr> <a title="a > b" href="https://example.org">#42</a></p>`
    );
  });

  it('links unique verified commit SHAs and leaves ambiguous, cross-repo, or unverified hex alone', () => {
    expect(
      linkifyGitHubHtml(
        `<p>See 0123456, ${SHA}, and acme/widgets@0123456. (not other/lib@0123456 or 0123456.ts or 0123456-abc or deadbeef or @0123456:example.org)</p>`,
        META
      )
    ).toBe(
      `<p>See ${a(META.commits[SHA]!, '<code>0123456</code>')}, ${a(META.commits[SHA]!, '<code>0123456</code>')}, and ${a(META.commits[SHA]!, '<code>acme/widgets@0123456</code>')}. (not other/lib@0123456 or 0123456.ts or 0123456-abc or deadbeef or @0123456:example.org)</p>`
    );
    expect(linkifyGitHubHtml('<p>Compare abcdef1 vs abcdef1a</p>', META)).toBe(
      `<p>Compare abcdef1 vs ${a(META.commits[SHA_A]!, '<code>abcdef1</code>')}</p>`
    );
  });

  it('links verified bare video attachment URLs with HTML-escaped labels and skips query/hash/existing links', () => {
    const asset = `https://github.com/user-attachments/assets/${UUID}`;
    const legacy = `https://github.com/acme/widgets/assets/9/${UUID}`;
    const label = 'demo [before] &amp; &lt;after&gt;.mp4';
    expect(linkifyGitHubHtml(`<p>Watch (${asset}).\n${legacy}</p>`, META)).toBe(
      `<p>Watch (${a(asset, label)}).\n${a(legacy, label)}</p>`
    );

    const keep = [
      `<p><a href="${asset}">${asset}</a></p>`,
      `<p><code>${asset}</code></p>`,
      `<p>https://github.com/user-attachments/assets/${OTHER_UUID}</p>`,
      `<p>${asset}?raw=1</p>`,
      `<p>${asset}#t=10</p>`,
    ].join('\n');
    expect(linkifyGitHubHtml(keep, META)).toBe(keep);
    // Attribute escaping on hrefs containing special characters.
    const queryMeta: GitHubBodyMeta = {
      links: { '#42': 'https://github.com/acme/widgets/issues/42?a=1&b=2' },
      commits: {},
      videos: {},
    };
    expect(linkifyGitHubHtml('<p>#42</p>', queryMeta)).toBe(
      `<p>${a('https://github.com/acme/widgets/issues/42?a=1&amp;b=2', '#42')}</p>`
    );
  });
});

describe('linear-time performance on pathological 64 KB inputs', () => {
  it('completes both stages on all adversarial 64 KB inputs in under 1000 ms total', () => {
    const inputs = [
      '['.repeat(65536),
      '<a '.repeat(21000),
      'a-'.repeat(32000),
      '<!--'.repeat(16000),
      '`'.repeat(65536),
      '<!--' + '`'.repeat(65536),
    ];
    const start = performance.now();
    for (const input of inputs) {
      stripGitHubHtmlComments(input);
      linkifyGitHubHtml(input, META);
    }
    expect(performance.now() - start).toBeLessThan(1000);
  });
});
