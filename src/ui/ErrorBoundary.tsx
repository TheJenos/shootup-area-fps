import { Component, type ErrorInfo, type ReactNode } from 'react';
import { errorMessage } from './errors';

interface State {
  error: string | null;
}

/**
 * The last line of defence for a rendering error: instead of React unmounting everything (a blank
 * page with no way on), a short message and a reload button. A game in progress is lost either way.
 */
export class ErrorBoundary extends Component<{ children: ReactNode }, State> {
  state: State = { error: null };

  static getDerivedStateFromError(err: unknown): State {
    return { error: errorMessage(err) };
  }

  componentDidCatch(err: unknown, info: ErrorInfo): void {
    console.error('Unhandled error while rendering', err, info.componentStack);
  }

  render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <section id="crash-screen" className="screen" role="alert">
        <div className="panel-box">
          <h2>Something went wrong</h2>
          <p className="muted">The page hit an error it couldn't recover from. Reloading takes you back to the lobby.</p>
          {import.meta.env.DEV && <pre className="muted">{this.state.error}</pre>}
          <button type="button" className="primary" onClick={() => location.reload()}>Reload</button>
        </div>
      </section>
    );
  }
}
