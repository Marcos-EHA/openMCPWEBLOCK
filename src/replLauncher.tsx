import React from 'react';
import type { StatsStore } from './context/stats.js';
import type { Root } from './ink.js';
import type { Props as REPLProps } from './screens/REPL.js';
import type { AppState } from './state/AppStateStore.js';
import type { FpsMetrics } from './utils/fpsTracker.js';
type AppWrapperProps = {
  getFpsMetrics: () => FpsMetrics | undefined;
  stats?: StatsStore;
  initialState: AppState;
};
export async function launchRepl(root: Root, appProps: AppWrapperProps, replProps: REPLProps, renderAndRun: (root: Root, element: React.ReactNode) => Promise<void>): Promise<void> {
  const {
    App
  } = await import('./components/App.js');
  const {
    REPL
  } = await import('./screens/REPL.js');
  try {
    const {
      orchestrationAppState
    } = await import('./services/webRelay/orchestration/AppState.js');
    const sentinel = await import('./services/webRelay/orchestration/Sentinel.js');
    await orchestrationAppState.init();
    sentinel.start();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[Web Relay startup] Orchestration bootstrap failed: ${message}\n`);
  }

  await renderAndRun(root, <App {...appProps}>
      <REPL {...replProps} />
    </App>);
}
