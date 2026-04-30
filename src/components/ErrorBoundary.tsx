/**
 * Error Boundary Component
 * Catches JavaScript errors in the component tree and displays fallback UI
 */

import React, { Component, ErrorInfo, ReactNode } from 'react';
import { logger } from '../utils';

interface Props {
  children: ReactNode;
  fallback?: ReactNode;
}

interface State {
  hasError: boolean;
  error?: Error;
}

export class ErrorBoundary extends Component<Props, State> {
  public state: State = {
    hasError: false
  };

  public static getDerivedStateFromError(error: Error): State {
    return { hasError: true, error };
  }

  public componentDidCatch(error: Error, errorInfo: ErrorInfo) {
    logger.error('Error boundary caught an error:', error, errorInfo);
  }

  public render() {
    if (this.state.hasError) {
      return this.props.fallback || (
        <div style={{
          padding: '2rem',
          textAlign: 'center',
          background: '#1a1a2e',
          color: '#e53e3e',
          borderRadius: '8px',
          border: '1px solid #e53e3e'
        }}>
          <h2>Something went wrong</h2>
          <p>An unexpected error occurred. Please refresh the page and try again.</p>
          <details style={{ marginTop: '1rem', textAlign: 'left' }}>
            <summary>Error Details</summary>
            <pre style={{ 
              background: '#000', 
              padding: '1rem', 
              borderRadius: '4px',
              overflow: 'auto',
              fontSize: '0.8rem'
            }}>
              {this.state.error?.stack || this.state.error?.message || 'Unknown error'}
            </pre>
          </details>
          <button
            onClick={() => window.location.reload()}
            style={{
              marginTop: '1rem',
              padding: '0.5rem 1rem',
              background: '#e53e3e',
              color: 'white',
              border: 'none',
              borderRadius: '4px',
              cursor: 'pointer'
            }}
          >
            Refresh Page
          </button>
        </div>
      );
    }

    return this.props.children;
  }
}