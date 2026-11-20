import { lazy } from 'react';
import { Icons } from 'folds';
import type { ClientPlugin } from '@mindroom/client-sdk/core';
import { parsePullRequestUrl } from './github';
import { PullRequestCard } from './PullRequestCard';
import { en } from './strings';
import { ThreadCardPullRequests } from './ThreadCardPullRequests';
import { PullRequestLinkHoverCard, ThreadDetails } from './ThreadDetails';
import { ThreadPullRequestsButton } from './ThreadPullRequestsButton';
import { threadHasDetails } from './threadPullRequests';
import './styles.css';

// The panel loads when it first opens: it carries the diff libraries, which the card does not need.
const PullRequestPanel = lazy(() => import('./PullRequestPanel'));

const plugin: ClientPlugin = {
  messageLinks: [
    {
      match: (url) => parsePullRequestUrl(url) !== undefined,
      Component: PullRequestCard,
      // The card's request, so a click while the panel shows this pull request opens it on GitHub.
      sidePanel: { id: 'pull-request', request: (url) => parsePullRequestUrl(url) },
      hoverCard: PullRequestLinkHoverCard,
    },
  ],
  sidePanels: [
    {
      id: 'pull-request',
      label: 'panelLabel',
      icon: Icons.Code,
      remember: true,
      Component: PullRequestPanel,
      // Its top row shows the pull request and its own Close, in place of the room's title row.
      title: 'own',
    },
  ],
  // Each chip opens its own hover card, so the card's details card stays closed over the chips.
  threadCardBadges: [{ Component: ThreadCardPullRequests, hoverCard: true }],
  threadDetails: [{ shows: threadHasDetails, Component: ThreadDetails }],
  threadHeaderSlot: [ThreadPullRequestsButton],
  translations: { en },
};

export default plugin;
