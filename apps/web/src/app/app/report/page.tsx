'use client';

import { useEffect, useState, type ReactNode } from 'react';
import type { BacktestSummary } from '@kovra/core';
import { useAppData } from '@/lib/store';

/** Minimal Markdown for the backtest report: headings, lists, bold, tables, paragraphs. */
function inline(text: string): ReactNode[] {
  return text.split(/(\*\*[^*]+\*\*)/g).map((part, i) => (part.startsWith('**') ? <b key={i}>{part.slice(2, -2)}</b> : part));
}

function renderMarkdown(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (l.startsWith('# ')) continue; // page title already shown
    if (l.startsWith('## ')) out.push(<div className="dsec" key={i} style={{ fontSize: 15 }}>{l.slice(3)}</div>);
    else if (l.startsWith('### ')) out.push(<div className="dsec" key={i}>{l.slice(4)}</div>);
    else if (l.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      i--;
      out.push(
        <ul key={i} style={{ paddingLeft: 18, color: 'var(--soft)', fontSize: 14, display: 'grid', gap: 6 }}>
          {items.map((t, k) => (
            <li key={k}>{inline(t)}</li>
          ))}
        </ul>,
      );
    } else if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++].split('|').slice(1, -1).map((c) => c.trim()));
      i--;
      const [head, , ...body] = rows;
      out.push(
        <div className="card tbl" key={i} style={{ padding: 4 }}>
          <table>
            <thead>
              <tr>{head.map((h, k) => <th key={k} className={k ? 'r' : undefined}>{h}</th>)}</tr>
            </thead>
            <tbody>
              {body.map((r, k) => (
                <tr key={k} style={{ cursor: 'default' }}>
                  {r.map((c, j) => (
                    <td key={j} className={j ? 'r num' : undefined}>
                      {inline(c)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
    } else if (l.trim()) out.push(<p key={i} style={{ color: 'var(--muted)', fontSize: 14.5, margin: '8px 0' }}>{inline(l)}</p>);
  }
  return out;
}

export default function ReportPage() {
  const { client } = useAppData();
  const [r, setR] = useState<BacktestSummary | null | undefined>(undefined);
  useEffect(() => {
    client?.latestBacktest().then(setR);
  }, [client]);
  return (
    <div className="page on" id="p-report">
      <div className="panel card">
        {r === undefined ? (
          <p className="muted">Loading…</p>
        ) : r === null ? (
          <p className="muted">
            No backtest yet. Run <code>pnpm --filter @kovra/agent backtest</code> on the server; the report shows up here.
          </p>
        ) : (
          <>
            <p className="dim" style={{ fontSize: 13 }}>
              Run on {new Date(r.createdAt).toLocaleString()}
            </p>
            {renderMarkdown(r.report)}
          </>
        )}
      </div>
    </div>
  );
}
