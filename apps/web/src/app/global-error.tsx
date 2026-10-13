'use client';

/** When even the root layout fails: the real message on the site's dark background, and a reload. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16, boxSizing: 'border-box', background: '#040404', color: '#F5F5F6', fontFamily: 'system-ui, sans-serif' }}>
        <div role="alert" style={{ maxWidth: 520, padding: '13px 14px', borderRadius: 11, background: 'rgba(255,99,105,.11)', border: '1px solid rgba(255,99,105,.2)', color: '#FF6369', fontSize: 14, lineHeight: 1.5 }}>
          Something on this page broke. The agent keeps running: this only affects what the page shows.
          <div style={{ color: '#CFCFD4', fontSize: 12.5, marginTop: 6, wordBreak: 'break-word' }}>
            {error.name}: {error.message}
            {error.digest ? ` (${error.digest})` : ''}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 12, padding: '7px 12px', borderRadius: 9, border: '1px solid rgba(255,255,255,.11)', background: '#19191B', color: '#F5F5F6', font: 'inherit', fontSize: 13, cursor: 'pointer' }}
          >
            Reload page
          </button>
        </div>
      </body>
    </html>
  );
}
