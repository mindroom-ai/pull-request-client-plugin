// Uses `React.act` on React 18.3+ and 19 (where `react-dom/test-utils` logs a deprecation error),
// falling back to `react-dom/test-utils` while MindRoom Chat `main` is on React 18.2.
import * as React from 'react';
import { act as legacyAct } from 'react-dom/test-utils';

type Act = typeof legacyAct;

const reactAct = (React as { act?: Act }).act;

export const act: Act = typeof reactAct === 'function' ? reactAct : legacyAct;
