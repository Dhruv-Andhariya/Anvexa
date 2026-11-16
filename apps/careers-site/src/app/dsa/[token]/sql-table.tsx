import type { SqlCell } from '@/lib/dsa-api';

const cellText = (c: SqlCell) => (c === null ? 'NULL' : String(c));

/** A table of rows (a SQL problem's sample data, an expected result, a query's result), in the page's code style. */
export function SqlTable({ columns, rows, caption, maxRows = 50 }: { columns: string[]; rows: SqlCell[][]; caption?: string; maxRows?: number }) {
  const shown = rows.slice(0, maxRows);
  return (
    <div className="max-h-64 overflow-auto rounded-md border border-border bg-background">
      <table className="w-full border-collapse font-mono text-xs">
        {caption && <caption className="sr-only">{caption}</caption>}
        <thead className="sticky top-0 bg-surface">
          <tr>
            {columns.map((c, i) => (
              <th key={`${c}-${i}`} scope="col" className="border-b border-border px-2 py-1 text-left font-semibold">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((row, r) => (
            <tr key={r} className="even:bg-surface/60">
              {row.map((cell, i) => (
                <td key={i} className={`whitespace-pre px-2 py-1 align-top ${cell === null ? 'italic text-muted' : ''}`}>
                  {cellText(cell)}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={Math.max(columns.length, 1)} className="px-2 py-1 text-muted">
                (no rows)
              </td>
            </tr>
          )}
        </tbody>
      </table>
      {rows.length > maxRows && <p className="px-2 py-1 text-xs text-muted">… {rows.length - maxRows} more rows</p>}
    </div>
  );
}
