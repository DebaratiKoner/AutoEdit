import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation, useNavigate, useParams } from 'react-router-dom';
import {
  Dashboard,
  EditorPage,
  ErrorBoundary,
  UploadPage,
} from './components';
import ShortsPage from './shorts/ShortsPage';
import { AuthPage, AuthProvider, useAuth } from './auth/Auth';

function AppRoutes() {
  const navigate = useNavigate();

  const handleUploadComplete = (sessionId: string) => {
    navigate(`/editor/${sessionId}`);
  };

  const handleReset = () => {
    navigate('/dashboard');
  };

  return (
    <Routes>
      <Route path="/" element={<Dashboard />} />
      <Route path="/auth" element={<AuthPage />} />
      <Route path="/login" element={<Navigate to="/auth?mode=login" replace />} />
      <Route path="/signup" element={<Navigate to="/auth?mode=signup" replace />} />
      <Route element={<ProtectedRoute />}>
        <Route path="/dashboard" element={<Dashboard />} />
        <Route path="/upload" element={<UploadPage onUploadComplete={handleUploadComplete} />} />
        <Route path="/editor/:sessionId" element={<EditorPageWrapper onReset={handleReset} />} />
        <Route path="/shorts" element={<ShortsPage />} />
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function EditorPageWrapper({ onReset }: { onReset: () => void }) {
  const { sessionId = '' } = useParams();
  return <EditorPage sessionId={sessionId} onReset={onReset} />;
}

function ProtectedRoute() {
  const { isAuthenticated } = useAuth();
  const location = useLocation();

  if (!isAuthenticated) {
    return <Navigate to="/auth?mode=login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AuthProvider>
          <AppRoutes />
        </AuthProvider>
      </BrowserRouter>
    </ErrorBoundary>
  );
}
