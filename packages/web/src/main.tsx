import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider, createBrowserRouter } from 'react-router-dom';
import './i18n';
import './theme/tokens.css';
import './renderers'; // registers built-in renderers (registry side effect)
import { App } from './App';
import { ManageHome } from './routes/ManageHome';
import { SessionPage } from './routes/SessionPage';
import { SettingsPage } from './routes/SettingsPage';
import { WorkspacePage } from './routes/WorkspacePage';
import { startIngest } from './stores/ingest';

// WS ingestion lives outside React (rAF-batched store writes).
startIngest();

const router = createBrowserRouter([
  {
    path: '/',
    element: <App />,
    children: [
      { index: true, element: <ManageHome /> },
      { path: 'workspace/:projectId', element: <WorkspacePage /> },
      { path: 'session/:sid', element: <SessionPage /> },
      { path: 'settings', element: <SettingsPage /> },
    ],
  },
]);

const rootElement = document.getElementById('root');
if (!rootElement) {
  throw new Error('Root element #root was not found');
}

createRoot(rootElement).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
);
