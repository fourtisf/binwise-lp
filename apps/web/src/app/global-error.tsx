'use client';

/** When even the root layout fails: the real message on the site's dark background, and a reload. */
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body style={{ margin: 0, minHeight: '100dvh', display: 'grid', placeItems: 'center', padding: 16, boxSizing: 'border-box', background: '#07080C', color: '#F3F4F8', fontFamily: 'system-ui, sans-serif' }}>
        <div role="alert" style={{ maxWidth: 520, padding: '13px 14px', borderRadius: 11, background: 'rgba(255,107,129,.11)', border: '1px solid rgba(255,107,129,.2)', color: '#FF6B81', fontSize: 14, lineHeight: 1.5 }}>
          Something on this page broke. The agent keeps running: this only affects what the page shows.
          <div style={{ color: '#C9CBD6', fontSize: 12.5, marginTop: 6, wordBreak: 'break-word' }}>
            {error.name}: {error.message}
            {error.digest ? ` (${error.digest})` : ''}
          </div>
          <button
            onClick={() => window.location.reload()}
            style={{ marginTop: 12, padding: '7px 12px', borderRadius: 9, border: '1px solid rgba(255,255,255,.11)', background: '#14151D', color: '#F3F4F8', font: 'inherit', fontSize: 13, cursor: 'pointer' }}
          >
            Reload page
          </button>
        </div>
      </body>
    </html>
  );
}
