import { createContext, useContext, useMemo, useState, type FormEvent, type ReactNode } from 'react';
import { useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';

interface AuthUser {
  name: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (email?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(null);

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      login: (email = 'user@autoedit.ai') => {
        setUser({ name: email.split('@')[0] || 'AutoEdit User', email });
      },
      logout: () => setUser(null),
    }),
    [user],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }

  return context;
}

export function AuthPage() {
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const { login } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const mode = searchParams.get('mode') === 'signup' ? 'signup' : 'login';

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault();
    login(email);
    const from = (location.state as { from?: string } | null)?.from;
    navigate(from && !from.startsWith('/auth') ? from : '/');
  };

  return (
    <main className="auth-screen ae-page">
      <header className="ae-topbar">
        <button className="ae-brand" onClick={() => navigate('/')} aria-label="AutoEdit AI home">
          <BrandLogo size="sm" animated />
          <span>AutoEdit</span>
        </button>
        <div className="ae-topnav">
          <span className="ae-status-dot">Engine Online</span>
          <button className="ae-ghost-button" onClick={() => navigate('/')}>Features</button>
        </div>
      </header>

      <section className="auth-layout">
        <div className="auth-copy">
          <p className="ae-kicker">PRISM Framework - v2.4.1</p>
          <h1>
            Autonomous Video
            <span>Post-Production</span>
            in &lt;5 Minutes
          </h1>
          <p>
            Sign in to launch the same dark production console shown in the reference: live jobs,
            pipeline gates, quality checks, and export-ready video workflows.
          </p>
          <div className="auth-preview-card">
            <div className="auth-preview-header">
              <span className="ae-live-pill">Live</span>
              <strong>PRISM Engine - Active Session</strong>
            </div>
            {[
              ['Scene Confidence', '84%', 'green'],
              ['Clip Adherence', '92%', 'blue'],
              ['Export Queue', '36%', 'amber'],
            ].map(([label, value, tone]) => (
              <div className="ae-progress-row" key={label}>
                <span>{label}</span>
                <div><i className={`tone-${tone}`} style={{ width: value }} /></div>
                <b>{value}</b>
              </div>
            ))}
          </div>
        </div>

        <form className="auth-card" onSubmit={handleSubmit}>
          <div className="auth-card-heading">
            <button className="auth-logo-button" type="button" onClick={() => navigate('/')} aria-label="AutoEdit AI home">
              <BrandLogo size="md" animated />
            </button>
            <p className="ae-kicker">{mode === 'login' ? 'Launch Console' : 'Create Workspace'}</p>
            <h2>{mode === 'login' ? 'Welcome back' : 'Start free trial'}</h2>
            <span>{mode === 'login' ? 'Access your AI production pipeline.' : 'Create your AI post-production workspace.'}</span>
          </div>

          <label className="auth-field">
            <span>Email Address</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              placeholder="you@example.com"
            />
          </label>

          <label className="auth-field">
            <span>Password</span>
            <input
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              required
              placeholder="Password"
            />
          </label>

          <button type="submit" className="ae-primary-button auth-submit">
            {mode === 'login' ? 'Launch App' : 'Start Free Trial'}
          </button>

          <p className="auth-switch">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => navigate(mode === 'login' ? '/auth?mode=signup' : '/auth?mode=login')}
            >
              {mode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          </p>
        </form>
      </section>
    </main>
  );
}
