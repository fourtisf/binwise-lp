'use client';

import { useEffect } from 'react';

/** Last resort for a crash outside the app's own error boundaries: the real message, and a way back. */
export default function AppError({ error, reset }: { error: Error & { digest?: string }; reset: () => void }) {
  useEffect(() => console.error('[binwise] page crashed:', error), [error]);
  return (
    <div style={{ minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16 }}>
      <div className="verdict stop" role="alert" style={{ maxWidth: 520 }}>
        Something on this page broke. The agent keeps running: this only affects what the page shows.
        <div style={{ color: 'var(--soft)', fontWeight: 400, fontSize: 12.5, marginTop: 6, wordBreak: 'break-word' }}>
          {error.name}: {error.message}
          {error.digest ? ` (${error.digest})` : ''}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <button className="btn btn-dark btn-sm" onClick={reset}>
            Try again
          </button>
          <button className="btn btn-dark btn-sm" onClick={() => window.location.reload()}>
            Reload page
          </button>
        </div>
      </div>
    </div>
  );
}
