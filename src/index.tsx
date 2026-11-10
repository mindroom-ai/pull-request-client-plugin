import { lazy } from 'react';
import { Icons } from 'folds';
import type { ClientPlugin } from '@mindroom/client-sdk/core';
import { parsePullRequestUrl } from './github';
import { PullRequestCard } from './PullRequestCard';
import { en } from './strings';
import './styles.css';

// The panel loads when it first opens: it carries the diff libraries, which the card does not need.
const PullRequestPanel = lazy(() => import('./PullRequestPanel'));

const plugin: ClientPlugin = {
  messageLinks: [
    {
      match: (url) => parsePullRequestUrl(url) !== undefined,
      Component: PullRequestCard,
    },
  ],
  sidePanels: [
    {
      id: 'pull-request',
      label: 'panelLabel',
      icon: Icons.Code,
      remember: true,
      Component: PullRequestPanel,
    },
  ],
  translations: { en },
};

export default plugin;
