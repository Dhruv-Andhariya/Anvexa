import type { SqlCell } from '@hireflow/contracts';

/** Rows of a table or a query result (SQL questions: sample data, expected results), compact and scrollable. */
export function SqlResultTable({ columns, rows, caption, maxRows = 20 }: { columns: string[]; rows: SqlCell[][]; caption: string; maxRows?: number }) {
  return (
    <div className="max-h-56 overflow-auto rounded-md border border-border bg-background">
      <table className="w-full border-collapse font-mono text-xs">
        <caption className="sr-only">{caption}</caption>
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
          {rows.slice(0, maxRows).map((row, r) => (
            <tr key={r}>
              {row.map((cell, i) => (
                <td key={i} className={`whitespace-pre px-2 py-1 ${cell === null ? 'italic text-muted' : ''}`}>
                  {cell === null ? 'NULL' : String(cell)}
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
