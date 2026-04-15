import { BrowserRouter, HashRouter, Routes, Route, Navigate } from 'react-router-dom';
import { lazy, Suspense } from 'react';
import { FeishuOAuthCallbackPage } from './pages/FeishuOAuthCallbackPage';
import { MemoryPage } from './pages/MemoryPage';
import { SkillsPage } from './pages/SkillsPage';
import { McpServersPage } from './pages/McpServersPage';
import { AuthGuard } from './components/auth/AuthGuard';
import { AppLayout } from './components/layout/AppLayout';
import { ErrorBoundary } from './components/common/ErrorBoundary';
import { APP_BASE, shouldUseHashRouter } from './utils/url';

const ChatPage = lazy(() => import('./pages/ChatPage').then(m => ({ default: m.ChatPage })));
const TasksPage = lazy(() => import('./pages/TasksPage').then(m => ({ default: m.TasksPage })));
const MonitorPage = lazy(() => import('./pages/MonitorPage').then(m => ({ default: m.MonitorPage })));
const SettingsPage = lazy(() => import('./pages/SettingsPage').then(m => ({ default: m.SettingsPage })));
const LogsPage = lazy(() => import('./pages/LogsPage').then(m => ({ default: m.LogsPage })));
const SearchPage = lazy(() => import('./pages/SearchPage').then(m => ({ default: m.SearchPage })));

export function App() {
  const Router = shouldUseHashRouter() ? HashRouter : BrowserRouter;

  return (
    <Router basename={APP_BASE === '/' ? undefined : APP_BASE}>
      <Routes>
        <Route path="/login" element={<Navigate to="/chat" replace />} />
        <Route path="/setup" element={<Navigate to="/chat" replace />} />
        <Route path="/setup/providers" element={<Navigate to="/settings?tab=claude" replace />} />
        <Route path="/setup/channels" element={<Navigate to="/settings?tab=channels" replace />} />

        {/* Feishu OAuth Callback */}
        <Route
          path="/feishu-oauth-callback"
          element={
            <AuthGuard>
              <FeishuOAuthCallbackPage />
            </AuthGuard>
          }
        />

        {/* Protected Routes with Layout */}
        <Route
          element={
            <AuthGuard>
              <AppLayout />
            </AuthGuard>
          }
        >
          <Route path="/chat/:sessionSlug?" element={<ErrorBoundary label="ChatPage"><Suspense fallback={null}><ChatPage /></Suspense></ErrorBoundary>} />
          <Route path="/search" element={<ErrorBoundary label="SearchPage"><Suspense fallback={null}><SearchPage /></Suspense></ErrorBoundary>} />
          <Route path="/groups" element={<Navigate to="/settings?tab=sessions" replace />} />
          <Route path="/tasks" element={<ErrorBoundary label="TasksPage"><Suspense fallback={null}><TasksPage /></Suspense></ErrorBoundary>} />
          <Route path="/monitor" element={<ErrorBoundary label="MonitorPage"><Suspense fallback={null}><MonitorPage /></Suspense></ErrorBoundary>} />
          <Route path="/memory" element={<MemoryPage />} />
          <Route path="/skills" element={<SkillsPage />} />
          <Route path="/mcp-servers" element={<McpServersPage />} />
          <Route path="/logs" element={<ErrorBoundary label="LogsPage"><Suspense fallback={null}><LogsPage /></Suspense></ErrorBoundary>} />
          <Route path="/settings" element={<ErrorBoundary label="SettingsPage"><Suspense fallback={null}><SettingsPage /></Suspense></ErrorBoundary>} />
        </Route>

        {/* Default redirect */}
        <Route path="/" element={<Navigate to="/chat" replace />} />
        <Route path="*" element={<Navigate to="/chat" replace />} />
      </Routes>
    </Router>
  );
}
