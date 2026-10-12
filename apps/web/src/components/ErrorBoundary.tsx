'use client';

import { Component, type ErrorInfo, type ReactNode } from 'react';

type Props = {
  /** What this part of the page is, for the message and the console */
  area: string;
  children: ReactNode;
  /** 'quiet': show nothing (an overlay that is hidden anyway); default: say what broke, with "Try again" */
  fallback?: 'quiet';
};
type State = { error: Error | null; where: string; key: number };

/** Remounts at most once per this long; a crash that keeps coming back shows its message instead. */
const AUTO_RETRY_MS = 10_000;

/**
 * Keeps one part of the page from taking the whole app down to Next's blank "Application error" screen.
 * A crash here (a bug, or a browser extension changing the page under React) remounts this part once;
 * if it crashes again right away, it shows the error itself and "Try again". Nothing on-chain depends on
 * the page: the agent keeps running.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null, where: '', key: 0 };
  private lastRetry = 0;

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    // The innermost component that failed, e.g. "AddLp", so a screenshot of the message says where.
    const where = /at (\w+)/.exec(info.componentStack ?? '')?.[1] ?? '';
    console.error(`[binwise] ${this.props.area} crashed${where ? ` in ${where}` : ''}:`, error, info.componentStack);
    if (Date.now() - this.lastRetry > AUTO_RETRY_MS) {
      this.lastRetry = Date.now();
      this.setState((s) => ({ error: null, where: '', key: s.key + 1 }));
    } else this.setState({ where });
  }

  private retry = () => this.setState((s) => ({ error: null, where: '', key: s.key + 1 }));

  render() {
    const { error, where, key } = this.state;
    if (!error) return <ErrorKey key={key}>{this.props.children}</ErrorKey>;
    if (this.props.fallback === 'quiet') return null;
    return (
      <div className="verdict stop" role="alert" style={{ margin: '12px 0' }}>
        This part of the page ({this.props.area}) hit an error. The agent keeps running: this only affects what the page shows.
        <div style={{ color: 'var(--soft)', fontWeight: 400, fontSize: 12.5, marginTop: 6, wordBreak: 'break-word' }}>
          {error.name}: {error.message}
          {where ? ` (in ${where})` : ''}
        </div>
        <button className="btn btn-dark btn-sm" style={{ marginTop: 10 }} onClick={this.retry}>
          Try again
        </button>
      </div>
    );
  }
}

/** A keyed wrapper: a new key remounts the children from scratch. */
function ErrorKey({ children }: { children: ReactNode }) {
  return <>{children}</>;
}
