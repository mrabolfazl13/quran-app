import { Component, type ErrorInfo, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { StrictMode } from 'react';

import { App } from './app/App';
import { AppStateProvider } from './app/app-state';
import './styles/tokens.css';
import './styles/fonts.css';

/**
 * Last line of defence. The app opens files the user picked (backups, pack
 * folders), so an unexpected throw must not blank the mushaf the reader is
 * reciting from: the shell stays mounted and the message stays on screen.
 */
class ErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error | null } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    // No telemetry endpoint exists by design (privacy: nothing leaves the
    // machine); the component stack is printed for the developer's console.
    console.error('Unhandled UI error', error, info.componentStack);
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div style={{ padding: 32, fontFamily: 'Vazirmatn, sans-serif' }}>
        <h1 style={{ fontSize: 22 }}>صفحهٔ برنامه متوقف شد</h1>
        <p style={{ color: '#5c6b64' }}>
          دادهٔ شما دست‌نخورده مانده است. برنامه را دوباره باز کنید؛ اگر تکرار شد، متن زیر را نگه دارید.
        </p>
        <pre className="mono" dir="ltr" style={{ whiteSpace: 'pre-wrap' }}>
          {this.state.error.message}
        </pre>
        <button type="button" onClick={() => window.location.reload()}>
          بارگذاری دوباره
        </button>
      </div>
    );
  }
}

const container = document.getElementById('root');
if (!container) throw new Error('index.html lost its #root element');

createRoot(container).render(
  <StrictMode>
    <ErrorBoundary>
      <AppStateProvider>
        <App />
      </AppStateProvider>
    </ErrorBoundary>
  </StrictMode>,
);
