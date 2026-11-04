/**
 * The program the SQL sandbox runs in a separate Node process (`node -e`), so a query that never ends can be killed
 * without touching the API. Reads one job (JSON) on stdin, writes one JSON line per dataset on stdout.
 *
 * For every dataset, a NEW in-memory SQLite database (nothing on disk, nothing shared between datasets or
 * candidates):
 *   1. setup, HR's text: the schema, then the dataset. Extensions are off; ATTACH / DETACH / PRAGMA are refused (no
 *      file can be opened or created).
 *   2. lock: PRAGMA query_only = ON (no write of any kind) and an authorizer that allows only reading: SELECT, reading
 *      columns, calling functions, recursive CTEs. INSERT, UPDATE, DELETE, CREATE, DROP, ALTER, ATTACH, PRAGMA,
 *      transactions... fail with "not authorized" before they run.
 *   3. the query: rows are read one by one and stop at `maxRows`.
 * SQLite's own memory is capped (hard_heap_limit). The parent enforces the time limit by killing this process.
 *
 * Modes: "query" runs `query` on each dataset; "inspect" (HR, saving a question) also lists the tables, their columns
 * and the first rows of each, then runs `query` (the reference query) for the expected result.
 *
 * Plain JavaScript (no TypeScript, no imports from the app): it is passed to node as text.
 */
export const SQL_WORKER_SOURCE = `
'use strict';
const { DatabaseSync, constants: C } = require('node:sqlite');

const READ_ONLY = new Set([C.SQLITE_SELECT, C.SQLITE_READ, C.SQLITE_FUNCTION, C.SQLITE_RECURSIVE]);
const SETUP_REFUSED = new Set([C.SQLITE_ATTACH, C.SQLITE_DETACH, C.SQLITE_PRAGMA]);

function cell(v) {
  if (v === null || typeof v === 'number' || typeof v === 'string') return v;
  if (typeof v === 'bigint') return Number.isSafeInteger(Number(v)) ? Number(v) : String(v);
  if (v instanceof Uint8Array) return "x'" + Buffer.from(v).toString('hex') + "'";
  return String(v);
}

function message(e) {
  return String((e && e.message) || e);
}

function quoteName(name) {
  return '"' + String(name).replace(/"/g, '""') + '"';
}

function setup(job, dataSql) {
  const db = new DatabaseSync(':memory:', { allowExtension: false });
  // without the authorizer the database could not be made read-only: never run a query then (older Node.js)
  if (typeof db.setAuthorizer !== 'function' || typeof db.prepare('SELECT 1').setReturnArrays !== 'function') {
    throw new Error('This Node.js version cannot run SQL queries safely (node:sqlite authorizer missing): use a current Node.js release.');
  }
  db.exec('PRAGMA hard_heap_limit = ' + Number(job.heapBytes));
  if (typeof db.enableDefensive === 'function') db.enableDefensive(true);
  db.setAuthorizer((action) => (SETUP_REFUSED.has(action) ? C.SQLITE_DENY : C.SQLITE_OK));
  db.exec(job.schemaSql);
  if (dataSql) db.exec(dataSql);
  db.setAuthorizer(null);
  return db;
}

function lock(db) {
  db.exec('PRAGMA query_only = ON');
  db.setAuthorizer((action) => (READ_ONLY.has(action) ? C.SQLITE_OK : C.SQLITE_DENY));
}

function run(db, sql, maxRows) {
  let stmt;
  try {
    stmt = db.prepare(sql);
  } catch (e) {
    return { ok: false, stage: 'prepare', error: message(e) };
  }
  stmt.setReturnArrays(true);
  const columns = stmt.columns().map((c) => c.name);
  const rows = [];
  try {
    for (const row of stmt.iterate()) {
      if (rows.length >= maxRows) return { ok: false, stage: 'run', tooManyRows: true, error: 'more than ' + maxRows + ' rows' };
      rows.push(row.map(cell));
    }
  } catch (e) {
    return { ok: false, stage: 'run', error: message(e) };
  }
  return { ok: true, columns, rows };
}

function tables(db, previewRows) {
  const names = db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY rowid").all().map((r) => r.name);
  return names.map((name) => {
    const columns = db.prepare('SELECT name, type FROM pragma_table_info(?)').all(name).map((c) => ({ name: c.name, type: c.type || '' }));
    let rows = [];
    if (previewRows > 0) {
      const stmt = db.prepare('SELECT * FROM ' + quoteName(name) + ' LIMIT ' + Number(previewRows));
      stmt.setReturnArrays(true);
      rows = stmt.all().map((r) => r.map(cell));
    }
    return { name, columns, rows };
  });
}

function handle(job, dataset, i) {
  let db;
  try {
    db = setup(job, dataset.dataSql);
  } catch (e) {
    return { i, ok: false, stage: 'setup', error: message(e) };
  }
  try {
    const listed = job.mode === 'inspect' ? tables(db, dataset.preview ? job.previewRows : 0) : undefined;
    lock(db);
    const out = run(db, job.query, job.maxRows);
    return listed ? Object.assign({ i, tables: listed }, out) : Object.assign({ i }, out);
  } catch (e) {
    return { i, ok: false, stage: 'setup', error: message(e) };
  } finally {
    db.close();
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => (input += d));
process.stdin.on('end', () => {
  const job = JSON.parse(input);
  job.datasets.forEach((dataset, i) => {
    process.stdout.write(JSON.stringify(handle(job, dataset, i)) + '\\n');
  });
});
`;
