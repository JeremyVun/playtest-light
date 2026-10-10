import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { useApp } from './app-context.tsx';
import { Layout } from './components/Layout.tsx';
import { Login } from './pages/Login.tsx';
import { Projects } from './pages/Projects.tsx';
import { NewProject } from './pages/NewProject.tsx';
import { ProjectDetail } from './pages/ProjectDetail.tsx';
import { Upgrade } from './pages/Upgrade.tsx';
import { Settings } from './pages/Settings.tsx';
import { NotFound } from './pages/NotFound.tsx';

function Protected({ children }: { children: React.ReactNode }) {
  const { user } = useApp();
  const loc = useLocation();
  if (!user) return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  return <Layout>{children}</Layout>;
}

export function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      <Route path="/" element={<Navigate to="/projects" replace />} />
      <Route path="/projects" element={<Protected><Projects /></Protected>} />
      <Route path="/projects/new" element={<Protected><NewProject /></Protected>} />
      <Route path="/projects/:id" element={<Protected><ProjectDetail /></Protected>} />
      <Route path="/upgrade/*" element={<Protected><Upgrade /></Protected>} />
      <Route path="/settings" element={<Protected><Settings /></Protected>} />
      <Route path="*" element={<NotFound />} />
    </Routes>
  );
}
