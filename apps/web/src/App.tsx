import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { Layout } from './components/Layout.js';
import { CanvasPage } from './pages/CanvasPage.js';
import { ChainDetailPage } from './pages/ChainDetailPage.js';
import { ChatPage } from './pages/ChatPage.js';
import { HomePage } from './pages/HomePage.js';
import { ProjectsPage } from './pages/ProjectsPage.js';
import { ProjectCompanionPage } from './pages/ProjectCompanionPage.js';
import { WelcomePage } from './pages/WelcomePage.js';
import { WorkbenchPage } from './pages/WorkbenchPage.js';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // The backend is fast and the data isn't volatile. Modest staleness
      // keeps re-mounts from refetching aggressively.
      staleTime: 10_000,
      // Surface API errors to the UI rather than silently retrying.
      retry: false,
      refetchOnWindowFocus: false,
    },
  },
});

export function App() {
  return (
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          {/* Local-first: no auth wall. The app is single-user, run by its owner. */}
          <Route element={<Layout />}>
            {/* Index = WelcomePage (Pitch Sprint Day 2). Canvas moves to /canvas. */}
            <Route index element={<WelcomePage />} />
            <Route path="/canvas" element={<CanvasPage />} />
            <Route path="/projects" element={<ProjectsPage />} />
            <Route path="/projects/:project_id" element={<ProjectCompanionPage />} />
            <Route path="/chains-list" element={<HomePage />} />
            <Route path="/chat" element={<ChatPage />} />
            <Route path="/chains/:chainId" element={<ChainDetailPage />} />
            <Route path="/workbench" element={<WorkbenchPage />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  );
}
