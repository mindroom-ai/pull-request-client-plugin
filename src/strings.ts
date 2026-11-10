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
  loadingFiles: 'Loading files',
  updated: 'updated {{time}}',
  receivesChanges: 'receives changes from',
  tab: { summary: 'Summary', code: 'Code' },
  // The checks' summary line, by `summarizeChecks`' key.
  checks: {
    none: 'No checks reported',
    failing: '{{count}} of {{total}} failing',
    oneWorkflowAndChecksAwaitingAction_one:
      '{{workflows}} workflow and {{count}} check awaiting action',
    oneWorkflowAndChecksAwaitingAction_other:
      '{{workflows}} workflow and {{count}} checks awaiting action',
    workflowsAndChecksAwaitingAction_one:
      '{{workflows}} workflows and {{count}} check awaiting action',
    workflowsAndChecksAwaitingAction_other:
      '{{workflows}} workflows and {{count}} checks awaiting action',
    workflowsAwaitingApproval_one: '{{count}} workflow awaiting approval',
    workflowsAwaitingApproval_other: '{{count}} workflows awaiting approval',
    checksAwaitingAction_one: '{{count}} check awaiting action',
    checksAwaitingAction_other: '{{count}} checks awaiting action',
    running: '{{count}} of {{total}} running',
    allPassed: 'All checks have passed',
    passing: '{{count}} of {{total}} passing',
  },
  opened: 'opened {{time}}',
  ghost: 'ghost',
  state: { open: 'Open', draft: 'Draft', closed: 'Closed', merged: 'Merged' },
  error: {
    notFound: 'GitHub did not find this pull request. A private repository needs a token.',
    rateLimited: "GitHub's rate limit was reached.",
    badToken: 'GitHub refused the saved token.',
    notFoundWithToken:
      'GitHub did not find this pull request. The saved token may not be able to read this repository.',
    failed: 'GitHub could not be reached.',
    failedStatus: 'GitHub answered with status {{status}}.',
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
