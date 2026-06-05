import { useAuth } from '../auth/Auth';
import { useNavigate } from 'react-router-dom';
import { BrandLogo } from './BrandLogo';
import './DropboxPage.css';

export function DropboxPage() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  if (!user) {
    navigate('/auth?mode=login');
    return null;
  }

  const handleLogout = () => {
    logout();
    navigate('/auth?mode=login');
  };

  return (
    <main className="dropbox-page ae-page">
      <header className="ae-topbar">
        <button className="ae-brand" onClick={() => navigate('/')} aria-label="AutoEdit AI home">
          <BrandLogo size="sm" animated />
          <span>AutoEdit</span>
        </button>
        <div className="ae-topnav">
          <span className="ae-status-dot">Connected</span>
          <span className="ae-user-info">Welcome, {user.name || user.email}!</span>
          <button className="ae-ghost-button" onClick={handleLogout}>Log out</button>
        </div>
      </header>

      <section className="dropbox-container">
        <div className="dropbox-header">
          <div className="dropbox-icon">📦</div>
          <h1>Dropbox Integration</h1>
          <p>Manage your video files and export directly to Dropbox</p>
        </div>

        <div className="dropbox-content">
          <div className="auth-success-card">
            <div className="success-icon">✓</div>
            <h2>Authentication Successful!</h2>
            <p className="user-email">{user.email}</p>
            <p className="welcome-text">You are now logged in and ready to use AutoEdit with Dropbox integration.</p>
          </div>

          <div className="dropbox-actions">
            <button 
              className="ae-primary-button action-button"
              onClick={() => navigate('/upload')}
            >
              📹 Upload Video
            </button>
            <button 
              className="ae-primary-button action-button"
              onClick={() => navigate('/dashboard')}
            >
              📊 Dashboard
            </button>
            <button 
              className="ae-primary-button action-button"
              onClick={() => {}}
            >
              ☁️ Connect Dropbox
            </button>
          </div>

          <div className="dropbox-info-cards">
            <div className="info-card">
              <h3>🔒 Your Account</h3>
              <p>
                <strong>Name:</strong> {user.name || 'User'}<br/>
                <strong>Email:</strong> {user.email}
              </p>
            </div>

            <div className="info-card">
              <h3>⚙️ Quick Settings</h3>
              <ul>
                <li>✓ Two-Factor Authentication</li>
                <li>✓ Secure API Connection</li>
                <li>✓ Auto-Save Enabled</li>
                <li>✓ Cloud Sync Active</li>
              </ul>
            </div>

            <div className="info-card">
              <h3>📝 Recent Activity</h3>
              <p>
                Your session started at: {new Date().toLocaleString()}<br/>
                <strong>Status:</strong> <span className="status-active">Active</span>
              </p>
            </div>
          </div>

          <div className="dropbox-note">
            <strong>🎬 Next Steps:</strong>
            <ul>
              <li>Upload your video files using the Upload Video button</li>
              <li>Configure Dropbox integration in the settings</li>
              <li>Use the Dashboard to manage your projects</li>
              <li>Export your edited videos directly to Dropbox</li>
            </ul>
          </div>
        </div>
      </section>

      <footer className="ae-footer">
        <p>© 2026 AutoEdit AI - Autonomous Video Post-Production</p>
      </footer>
    </main>
  );
}
