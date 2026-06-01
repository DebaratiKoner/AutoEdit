import { createContext, useContext, useMemo, useState, useEffect, type FormEvent, type ReactNode } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { BrandLogo } from '../components/BrandLogo';

interface AuthUser {
  name: string;
  email: string;
}

interface AuthContextValue {
  user: AuthUser | null;
  isAuthenticated: boolean;
  login: (email?: string, name?: string) => void;
  logout: () => void;
}

const AuthContext = createContext<AuthContextValue | undefined>(undefined);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<AuthUser | null>(() => {
    try {
      const savedUser = localStorage.getItem('autoedit_user');
      return savedUser ? JSON.parse(savedUser) : null;
    } catch {
      return null;
    }
  });

  const value = useMemo<AuthContextValue>(
    () => ({
      user,
      isAuthenticated: user !== null,
      login: (email = 'user@autoedit.ai', name?: string) => {
        const authUser = { name: name || email.split('@')[0] || 'AutoEdit User', email };
        setUser(authUser);
        localStorage.setItem('autoedit_user', JSON.stringify(authUser));
      },
      logout: () => {
        setUser(null);
        localStorage.removeItem('autoedit_user');
      },
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

// Modal Component for alerts
interface ModalProps {
  isOpen: boolean;
  title: string;
  message: string;
  type: 'error' | 'success' | 'warning';
  onClose: () => void;
}

function Modal({ isOpen, title, message, type, onClose }: ModalProps) {
  if (!isOpen) return null;

  const bgColor = type === 'error' ? 'rgba(255, 74, 74, 0.1)' : type === 'success' ? 'rgba(74, 255, 122, 0.1)' : 'rgba(74, 158, 255, 0.1)';
  const borderColor = type === 'error' ? '#ff4a4a' : type === 'success' ? '#4aff7a' : '#4a9eff';
  const titleColor = type === 'error' ? '#ff4a4a' : type === 'success' ? '#4aff7a' : '#4a9eff';
  const icon = type === 'error' ? '⚠️' : type === 'success' ? '✓' : 'ℹ️';

  return (
    <div style={{
      position: 'fixed',
      top: 0,
      left: 0,
      right: 0,
      bottom: 0,
      background: 'rgba(0, 0, 0, 0.7)',
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      zIndex: 1000,
      animation: 'fadeIn 0.3s ease',
    }}>
      <div style={{
        background: bgColor,
        border: `2px solid ${borderColor}`,
        borderRadius: '12px',
        padding: '2rem',
        maxWidth: '500px',
        textAlign: 'center',
        boxShadow: `0 8px 32px ${borderColor}40`,
      }}>
        <div style={{ fontSize: '2.5rem', marginBottom: '1rem' }}>{icon}</div>
        <h2 style={{ color: titleColor, margin: '0.5rem 0', fontSize: '1.5rem' }}>{title}</h2>
        <p style={{ color: '#aaa', margin: '1rem 0', lineHeight: '1.6' }}>{message}</p>
        <button
          onClick={onClose}
          style={{
            background: `linear-gradient(135deg, ${borderColor}, ${borderColor}dd)`,
            color: '#fff',
            border: 'none',
            padding: '0.8rem 1.5rem',
            borderRadius: '6px',
            cursor: 'pointer',
            fontSize: '1rem',
            fontWeight: '600',
            marginTop: '1rem',
            transition: 'all 0.3s ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.05)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          OK
        </button>
      </div>
      <style>{`
        @keyframes fadeIn {
          from {
            opacity: 0;
          }
          to {
            opacity: 1;
          }
        }
      `}</style>
    </div>
  );
}

export function AuthPage() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { login, isAuthenticated, logout } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const mode = searchParams.get('mode') === 'signup' ? 'signup' : 'login';

  // Modal state
  const [modal, setModal] = useState<{ isOpen: boolean; title: string; message: string; type: 'error' | 'success' | 'warning' }>({
    isOpen: false,
    title: '',
    message: '',
    type: 'error',
  });

  // Real Database State connecting to SQLite backend
  const [registeredUsers, setRegisteredUsers] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isAdmin, setIsAdmin] = useState(false);

  // Fetch the real table of users when the page loads
  useEffect(() => {
    fetch('/api/users')
      .then(res => res.json())
      .then(data => {
        if (data.users) setRegisteredUsers(data.users);
      })
      .catch(() => console.log('Backend not connected yet.'));
  }, [mode]);

  const showModal = (title: string, message: string, type: 'error' | 'success' | 'warning' = 'error') => {
    setModal({ isOpen: true, title, message, type });
  };

  const closeModal = () => {
    setModal({ ...modal, isOpen: false });
  };

  const handleSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setIsLoading(true);

    if (mode === 'signup') {
      // Simple Validation - no password restrictions
      if (!firstName.trim() || !lastName.trim()) {
        showModal('Validation Error', 'Please enter both first and last name.', 'warning');
        setIsLoading(false);
        return;
      }

      if (!email.trim()) {
        showModal('Validation Error', 'Please enter a valid email address.', 'warning');
        setIsLoading(false);
        return;
      }

      if (!password.trim()) {
        showModal('Validation Error', 'Please enter a password.', 'warning');
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/signup', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ 
            name: `${firstName.trim()} ${lastName.trim()}`, 
            first_name: firstName.trim(), 
            last_name: lastName.trim(), 
            email: email.trim().toLowerCase(), 
            password: password,
          })
        });
        const data = await response.json();

        if (data.success) {
          setIsLoading(false);
          showModal(
            'Account Created Successfully!',
            `Welcome ${firstName}! Your account has been created. Logging you in automatically...`,
            'success'
          );
          setRegisteredUsers(data.users || []);
          
          // Auto log in and open the next page (Dropbox) after 2 seconds
          setTimeout(() => {
            login(email, data.user.name || `${firstName} ${lastName}`);
            navigate('/dropbox');
          }, 2000);
        } else {
          setIsLoading(false);
          showModal(
            'Registration Failed',
            data.message || (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) || 'Failed to create account. Please try again.',
            'error'
          );
        }
      } catch (err) {
        setIsLoading(false);
        showModal(
          'Connection Error',
          `Could not reach backend! Check if 'python main.py' is running. Error: ${(err as Error).message}`,
          'error'
        );
      }
    } else {
      // Login Mode
      if (!email.trim() || !password.trim()) {
        showModal('Missing Credentials', 'Please enter both email and password.', 'warning');
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: email.trim().toLowerCase(), password })
        });
        const data = await response.json();

        if (data.success && data.user) {
          const userName = data.user.name || `${data.user.first_name || ''} ${data.user.last_name || ''}`.trim() || email;
          login(data.user.email, userName);
          showModal(
            'Login Successful!',
            `Welcome back, ${userName}! Redirecting to Dropbox...`,
            'success'
          );
          
          // Redirect to Dropbox page after showing success message
          setTimeout(() => {
            setIsLoading(false);
            navigate('/dropbox');
          }, 1500);
        } else {
          setIsLoading(false);
          showModal(
            'Login Failed',
            data.message || (typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail)) || 'Invalid credentials. Please try again.',
            'error'
          );
        }
      } catch (err) {
        setIsLoading(false);
        showModal(
          'Connection Error',
          `Could not reach backend! Check if 'python main.py' is running. Error: ${(err as Error).message}`,
          'error'
        );
      }
    }

    setIsLoading(false);
  };

  return (
    <main className="auth-screen ae-page">
      <header className="ae-topbar">
        <button className="ae-brand" onClick={() => navigate('/')} aria-label="AutoEdit AI home">
          <BrandLogo size="sm" animated />
          <span>AutoEdit</span>
        </button>
        <div className="ae-topnav">
          <span className="ae-status-dot" onDoubleClick={() => setIsAdmin(prev => !prev)} title="Secret Admin Toggle" style={{ cursor: 'pointer' }}>Engine Online</span>
          <button className="ae-ghost-button" onClick={() => navigate('/')}>Features</button>
          {isAdmin && <button className="ae-ghost-button" onClick={() => window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' })}>View Database</button>}
          {isAuthenticated ? (
            <button className="ae-ghost-button" onClick={() => { logout(); navigate('/auth?mode=signup'); }}>Log out</button>
          ) : (
            <button className="ae-ghost-button" onClick={() => navigate(mode === 'login' ? '/auth?mode=signup' : '/auth?mode=login')}>
              {mode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          )}
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
            <h2>{mode === 'login' ? 'Welcome back' : 'Create an account'}</h2>
            <span>{mode === 'login' ? 'Access your AI production pipeline.' : 'Start your AI post-production journey.'}</span>
          </div>

          {mode === 'signup' && (
            <div style={{ display: 'flex', gap: '1rem', width: '100%' }}>
              <label className="auth-field" style={{ flex: 1 }}>
                <span>First Name</span>
                <input
                  type="text"
                  value={firstName}
                  onChange={(event) => setFirstName(event.target.value)}
                  required={mode === 'signup'}
                  placeholder="Jane"
                  disabled={isLoading}
                />
              </label>
              <label className="auth-field" style={{ flex: 1 }}>
                <span>Last Name</span>
                <input
                  type="text"
                  value={lastName}
                  onChange={(event) => setLastName(event.target.value)}
                  required={mode === 'signup'}
                  placeholder="Doe"
                  disabled={isLoading}
                />
              </label>
            </div>
          )}

          <label className="auth-field">
            <span>Email Address</span>
            <input
              type="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              required
              placeholder="you@example.com"
              disabled={isLoading}
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
              disabled={isLoading}
            />
          </label>

          <button type="submit" className="ae-primary-button auth-submit" disabled={isLoading} style={{ opacity: isLoading ? 0.6 : 1 }}>
            {isLoading ? (mode === 'login' ? 'Logging in...' : 'Creating account...') : (mode === 'login' ? 'Launch App' : 'Create Account')}
          </button>

          <p className="auth-switch">
            {mode === 'login' ? "Don't have an account? " : 'Already have an account? '}
            <button
              type="button"
              onClick={() => {
                navigate(mode === 'login' ? '/auth?mode=signup' : '/auth?mode=login');
              }}
              disabled={isLoading}
            >
              {mode === 'login' ? 'Sign up' : 'Log in'}
            </button>
          </p>
        </form>
      </section>

      {/* Real Database Accounts Table View */}
      {isAdmin && (
        <section style={{ maxWidth: '1200px', margin: '3rem auto', padding: '0 2rem', width: '100%', boxSizing: 'border-box' }}>
          <div style={{ background: 'rgba(26, 26, 46, 0.8)', border: '1px solid #2a2a3e', borderRadius: '12px', padding: '2rem', overflowX: 'auto' }}>
            <div style={{ display: 'flex', alignItems: 'center', marginBottom: '1.5rem' }}>
              <h3 style={{ color: '#4aff7a', marginTop: 0, marginBottom: 0, fontSize: '1.2rem', fontWeight: '700' }}>📊 Registered Users Database</h3>
              <span style={{ color: '#666', marginLeft: '1rem', fontSize: '0.9rem' }}>Total: {registeredUsers.length} user{registeredUsers.length !== 1 ? 's' : ''}</span>
            </div>
            
            <table style={{ 
              width: '100%', 
              textAlign: 'left', 
              color: '#aaa', 
              borderCollapse: 'collapse', 
              fontSize: '0.95rem',
              background: 'rgba(13, 13, 26, 0.5)',
              borderRadius: '8px',
              overflow: 'hidden'
            }}>
              <thead>
                <tr style={{ background: 'rgba(74, 158, 255, 0.1)', borderBottom: '2px solid #4a9eff' }}>
                  <th style={{ padding: '15px', color: '#4aff7a', fontWeight: '700', textAlign: 'left' }}>ID</th>
                  <th style={{ padding: '15px', color: '#4aff7a', fontWeight: '700', textAlign: 'left' }}>First Name</th>
                  <th style={{ padding: '15px', color: '#4aff7a', fontWeight: '700', textAlign: 'left' }}>Last Name</th>
                  <th style={{ padding: '15px', color: '#4aff7a', fontWeight: '700', textAlign: 'left' }}>Email Address</th>
                  <th style={{ padding: '15px', color: '#4aff7a', fontWeight: '700', textAlign: 'left' }}>Password</th>
                  <th style={{ padding: '15px', color: '#4aff7a', fontWeight: '700', textAlign: 'left' }}>Created At</th>
                </tr>
              </thead>
              <tbody>
                {registeredUsers.length > 0 ? (
                  registeredUsers.map((u, i) => (
                  <tr key={i} style={{ 
                    borderBottom: '1px solid #2a2a3e',
                    background: i % 2 === 0 ? 'transparent' : 'rgba(74, 158, 255, 0.05)',
                    transition: 'background 0.3s ease'
                  }}
                  onMouseEnter={(e) => e.currentTarget.style.background = 'rgba(74, 158, 255, 0.15)'}
                  onMouseLeave={(e) => e.currentTarget.style.background = i % 2 === 0 ? 'transparent' : 'rgba(74, 158, 255, 0.05)'}
                  >
                    <td style={{ padding: '15px', color: '#4aff7a', fontWeight: '700' }}>{u.id}</td>
                    <td style={{ padding: '15px', color: '#fff', fontWeight: '500' }}>{u.first_name || (u.name ? u.name.split(' ')[0] : 'N/A')}</td>
                    <td style={{ padding: '15px', color: '#fff', fontWeight: '500' }}>{u.last_name || (u.name ? u.name.substring(u.name.indexOf(' ') + 1) : '')}</td>
                    <td style={{ padding: '15px', color: '#4a9eff' }}>{u.email}</td>
                    <td style={{ padding: '15px', fontFamily: 'monospace', color: '#888', letterSpacing: '2px', fontSize: '0.85rem' }}>##########</td>
                    <td style={{ padding: '15px', color: '#888', fontSize: '0.85rem' }}>{u.created_at ? new Date(u.created_at).toLocaleString() : 'N/A'}</td>
                  </tr>
                  ))
                ) : (
                  <tr>
                    <td colSpan={6} style={{ padding: '30px 15px', textAlign: 'center', color: '#666' }}>
                      No users registered yet. Create an account above to see it appear here!
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
            
            <div style={{ marginTop: '1.5rem', padding: '1rem', background: 'rgba(74, 158, 255, 0.05)', borderLeft: '4px solid #4a9eff', borderRadius: '4px' }}>
              <p style={{ color: '#aaa', margin: '0', fontSize: '0.85rem' }}>
                ✓ All passwords are securely hashed and encrypted. The table above masks passwords with # for security.
              </p>
            </div>
          </div>
        </section>
      )}

      {/* Modal Alert */}
      <Modal
        isOpen={modal.isOpen}
        title={modal.title}
        message={modal.message}
        type={modal.type}
        onClose={closeModal}
      />
    </main>
  );
}
