// The plugin's English strings, `translations.en`; components translate them with
// `usePluginTranslation('pull-requests')`.
export const en = {
  panelLabel: 'Pull request',
  openInSidePanel: 'Open in side panel',
  openOnGitHub: 'Open on GitHub',
  copyLink: 'Copy link',
  copied: 'Copied',
  emptyPanel: 'Click a pull request link in a message to show it here.',
  noDescription: 'No description.',
  noDiff: 'No diff to show',
  code: {
    files: 'Files',
    fileCount_one: '{{count}} file',
    fileCount_other: '{{count}} files',
    treeLabel: 'Files of {{owner}}/{{repo}} #{{number}}',
    collapseFolders: 'Collapse all folders',
    expandFolders: 'Expand all folders',
  },
  loading: 'Loading pull request',
  opened: 'opened {{time}}',
  ghost: 'ghost',
  state: { open: 'Open', draft: 'Draft', closed: 'Closed', merged: 'Merged' },
  error: {
    notFound: 'GitHub did not find this pull request. A private repository needs a token.',
    rateLimited: "GitHub's rate limit was reached.",
    badToken: 'GitHub refused the saved token.',
    failed: 'GitHub could not be reached.',
    retry: 'Try again',
  },
  token: {
    label: 'GitHub token',
    save: 'Save',
    forget: 'Forget token',
    hint: {
      notFound: 'A token that can read the repository shows it.',
      rateLimited: 'A token raises the limit.',
      badToken: 'Save another token to replace it.',
    },
    note: "The token stays in this browser, where the page's scripts can read it.",
  },
};
