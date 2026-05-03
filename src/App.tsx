/**
 * Main App Component
 * Handles routing between Upload and Editor pages
 */

import { BrowserRouter, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { UploadPage, EditorPage, ErrorBoundary } from './components';

function AppRoutes() {
  const navigate = useNavigate();

  const handleUploadComplete = (sessionId: string) => {
    navigate(`/editor/${sessionId}`);
  };

  const handleReset = () => {
    navigate('/');
  };

  return (
    <Routes>
      <Route path="/" element={<UploadPage onUploadComplete={handleUploadComplete} />} />
      <Route
        path="/editor/:sessionId"
        element={
          <EditorPageWrapper onReset={handleReset} />
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function EditorPageWrapper({ onReset }: { onReset: () => void }) {
  const sessionId = window.location.pathname.split('/').pop() || '';
  return <EditorPage sessionId={sessionId} onReset={onReset} />;
}

export function App() {
  return (
    <ErrorBoundary>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </ErrorBoundary>
  );
}
