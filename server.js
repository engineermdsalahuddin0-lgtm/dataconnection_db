'use strict';

const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const sql = require('mssql');
const { buildCashSlips, missingColumns, DEFAULT_CUTOFF, REQUIRED } = require('./cash-slip');

const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '127.0.0.1';
const CONNECT_TIMEOUT_MS = 10000;
const DEFAULT_PORTS = { mysql: 3306, mssql: 1433 };

// System databases hidden only when the client asks for it (hideSystem: true).
const SYSTEM_DBS = {
  mysql: ['information_schema', 'mysql', 'performance_schema', 'sys'],
  mssql: ['master', 'tempdb', 'model', 'msdb'],
};

// The read endpoints use POST only so DB credentials travel in the request body,
// not in the URL (where they would land in browser history and logs). Nothing
// else may be posted, and no other write-style method is accepted at all.
const READ_ENDPOINTS = new Set(['/api/connect', '/api/tables', '/api/columns', '/api/cash-slips']);

const app = express();
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.method === 'POST' && READ_ENDPOINTS.has(req.path)) return next();
  res.set('Allow', READ_ENDPOINTS.has(req.path) ? 'POST' : 'GET, HEAD');
  return res.status(405).json({
    ok: false,
    error: { type: 'READ_ONLY_BLOCKED', severity: 'warning', message: `${req.method} ${req.path} is not allowed: this app is read-only.` },
  });
});
app.use(express.json({ limit: '100kb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ------------------------------------------------------------------ */
/* Helpers                                                            */
/* ------------------------------------------------------------------ */

class ValidationError extends Error {}

function parseCredentials(body, { requireDatabase = false } = {}) {
  const engine = String(body.engine || '').toLowerCase();
  if (!['mysql', 'mssql'].includes(engine)) {
    throw new ValidationError('Engine must be "mysql" or "mssql".');
  }

  const host = String(body.host || '').trim();
  if (!host) throw new ValidationError('Host / IP address is required.');

  let port = DEFAULT_PORTS[engine];
  if (body.port !== undefined && body.port !== null && String(body.port).trim() !== '') {
    port = Number(body.port);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      throw new ValidationError('Port must be a whole number between 1 and 65535.');
    }
  }

  const user = String(body.user || '').trim();
  if (!user) throw new ValidationError('Username is required.');

  const password = body.password == null ? '' : String(body.password);

  const database = body.database == null ? '' : String(body.database).trim();
  if (requireDatabase && !database) throw new ValidationError('Database name is required.');

  return {
    engine,
    host,
    port,
    user,
    password,
    database,
    encrypt: Boolean(body.encrypt),
    hideSystem: Boolean(body.hideSystem),
  };
}

function mysqlConfig(c) {
  return {
    host: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database || undefined,
    connectTimeout: CONNECT_TIMEOUT_MS,
  };
}

function mssqlConfig(c) {
  return {
    server: c.host,
    port: c.port,
    user: c.user,
    password: c.password,
    database: c.database || undefined,
    connectionTimeout: CONNECT_TIMEOUT_MS,
    requestTimeout: 15000,
    pool: { max: 1, min: 0, idleTimeoutMillis: 1000 },
    options: {
      encrypt: c.encrypt,
      // Most self-hosted servers use self-signed certs; accept them.
      trustServerCertificate: true,
      enableArithAbort: true,
    },
  };
}

/*
 * READ-ONLY GUARANTEE. This app must never change data on the server. Three layers:
 *   1. Every statement must be a single SELECT/SHOW (assertReadOnly), checked before it is sent.
 *   2. MySQL sessions are switched to READ ONLY, so the server itself rejects any write.
 *   3. SQL Server work runs inside a transaction that is always rolled back, never committed.
 * Route handlers only ever see the guarded wrappers below, never the raw connection.
 */
class ReadOnlyError extends Error {}

function assertReadOnly(text) {
  const s = String(text || '');
  const problem =
    !/^\s*(SELECT|SHOW)\b/i.test(s) ? 'only SELECT / SHOW statements are allowed' :
    /;\s*\S/.test(s) ? 'multiple statements are not allowed' :
    /\bINTO\b/i.test(s) ? 'SELECT ... INTO writes data and is not allowed' :
    /\bFOR\s+UPDATE\b/i.test(s) ? 'locking reads (FOR UPDATE) are not allowed' :
    null;
  if (problem) throw new ReadOnlyError(`Blocked by read-only mode: ${problem}.`);
}

/** Run `fn` with a read-only MySQL connection, always closing it afterwards. */
async function withMysql(c, fn, extra = {}) {
  const conn = await mysql.createConnection({ ...mysqlConfig(c), ...extra, multipleStatements: false });
  try {
    await conn.query('SET SESSION TRANSACTION READ ONLY');
    const guarded = {
      query(q, params) {
        assertReadOnly(typeof q === 'string' ? q : q && q.sql);
        return conn.query(q, params);
      },
    };
    return await fn(guarded);
  } finally {
    await conn.end().catch(() => {});
  }
}

/** Run `fn` with a dedicated MSSQL pool; all requests run in a transaction that is rolled back. */
async function withMssql(c, fn) {
  const pool = new sql.ConnectionPool(mssqlConfig(c));
  await pool.connect();
  const tx = new sql.Transaction(pool);
  let began = false;
  try {
    await tx.begin();
    began = true;
    const guarded = {
      request() {
        const r = new sql.Request(tx);
        const run = r.query.bind(r);
        r.query = (text) => { assertReadOnly(text); return run(text); };
        r.batch = r.execute = () => { throw new ReadOnlyError('Blocked by read-only mode: batches and stored procedures are not allowed.'); };
        return r;
      },
    };
    return await fn(guarded);
  } finally {
    if (began) await tx.rollback().catch(() => {});
    await pool.close().catch(() => {});
  }
}

/**
 * Translate driver errors into a human-readable message + HTTP status.
 * mysql2 and mssql (tedious) expose different codes; both are handled here.
 */
function describeError(err, c) {
  const inner = err.originalError || {};
  const raw = err.message || inner.message || String(err);
  const target = c ? `${c.host}:${c.port}` : 'the server';

  // tedious wraps the real socket error (e.g. ECONNREFUSED) inside
  // originalError.cause.errors, under a generic ESOCKET. Prefer the specific one.
  const nested = [inner.cause, ...((inner.cause && inner.cause.errors) || [])]
    .map((e) => e && e.code)
    .filter(Boolean);
  const code = nested.find((k) => k !== 'ESOCKET') || err.code || inner.code || '';

  const lower = raw.toLowerCase();
  const map = [
    {
      // Our own guard, or the MySQL server refusing a write in a READ ONLY session.
      test: err instanceof ReadOnlyError || code === 'ER_CANT_EXECUTE_IN_READ_ONLY_TRANSACTION' || lower.includes('read only transaction'),
      status: 403,
      type: 'READ_ONLY_BLOCKED',
      message: err instanceof ReadOnlyError ? raw : 'Blocked by read-only mode: the database refused a write. Nothing was changed.',
    },
    {
      test: ['ER_ACCESS_DENIED_ERROR', 'ELOGIN', 'ER_DBACCESS_DENIED_ERROR'].includes(code) ||
        lower.includes('login failed') || lower.includes('access denied'),
      status: 401,
      type: 'AUTHENTICATION_FAILED',
      message: 'Authentication failed: the username or password was rejected, or this user has no access.',
    },
    {
      test: code === 'ER_BAD_DB_ERROR' || lower.includes('cannot open database'),
      status: 404,
      type: 'DATABASE_NOT_FOUND',
      message: `Database "${c && c.database}" does not exist or this user cannot open it.`,
    },
    {
      test: ['ETIMEDOUT', 'ETIMEOUT'].includes(code) || lower.includes('timeout') || lower.includes('timed out'),
      status: 504,
      type: 'CONNECTION_TIMEOUT',
      message: `Connection timed out after ${CONNECT_TIMEOUT_MS / 1000}s trying to reach ${target}. Check the host, port, and any firewall in between.`,
    },
    {
      test: code === 'ECONNREFUSED' || lower.includes('econnrefused'),
      status: 502,
      type: 'CONNECTION_REFUSED',
      message: `Connection refused by ${target}. The host is reachable but nothing is listening on that port (wrong port, or the database service is stopped).`,
    },
    {
      test: ['ENOTFOUND', 'EAI_AGAIN'].includes(code) || lower.includes('getaddrinfo'),
      status: 502,
      type: 'HOST_NOT_FOUND',
      message: `Host "${c && c.host}" could not be resolved. Check the hostname or IP address.`,
    },
    {
      test: ['EHOSTUNREACH', 'ENETUNREACH'].includes(code) || lower.includes('unreach'),
      status: 502,
      type: 'HOST_UNREACHABLE',
      message: `Host ${target} is unreachable from this machine (no network route).`,
    },
    {
      test: code === 'ESOCKET' || code === 'ECONNRESET',
      status: 502,
      type: 'SOCKET_ERROR',
      message: `The connection to ${target} was dropped. For SQL Server, try toggling "Encrypt connection".`,
    },
  ];

  const hit = map.find((m) => m.test);
  if (hit) return { status: hit.status, type: hit.type, message: hit.message, code, detail: raw };
  return { status: 500, type: 'DATABASE_ERROR', message: raw, code, detail: raw };
}

// Problems while reading data are reported as warnings: nothing is ever written,
// so a failed read never leaves the database in a bad state.
function sendError(res, err, c) {
  if (err instanceof ValidationError) {
    return res.status(400).json({ ok: false, error: { type: 'VALIDATION_ERROR', severity: 'warning', message: err.message } });
  }
  const info = describeError(err, c);
  console.warn(`[warning] ${info.type} (${info.code || 'no code'}): ${info.detail}`);
  return res.status(info.status).json({ ok: false, error: { ...info, severity: 'warning' } });
}

/* ------------------------------------------------------------------ */
/* Routes                                                             */
/* ------------------------------------------------------------------ */

// Endpoint 1: list databases on the server.
app.post('/api/connect', async (req, res) => {
  let c;
  try {
    c = parseCredentials(req.body || {});
    c.database = ''; // connect at server level

    let databases;
    let version;
    if (c.engine === 'mysql') {
      ({ databases, version } = await withMysql(c, async (conn) => {
        const [rows] = await conn.query('SHOW DATABASES');
        const [[v]] = await conn.query('SELECT VERSION() AS version');
        return { databases: rows.map((r) => r.Database), version: v.version };
      }));
    } else {
      ({ databases, version } = await withMssql(c, async (pool) => {
        const r = await pool.request().query('SELECT name FROM sys.databases ORDER BY name');
        const v = await pool.request().query("SELECT CAST(SERVERPROPERTY('ProductVersion') AS nvarchar(128)) AS version");
        return { databases: r.recordset.map((row) => row.name), version: v.recordset[0].version };
      }));
    }

    if (c.hideSystem) {
      const sys = SYSTEM_DBS[c.engine];
      databases = databases.filter((d) => !sys.includes(String(d).toLowerCase()));
    }

    console.log(`\n[connect] ${c.engine} ${c.user}@${c.host}:${c.port} — ${databases.length} database(s), version ${version}`);
    console.table(databases.map((name) => ({ database: name })));

    res.json({ ok: true, engine: c.engine, server: `${c.host}:${c.port}`, version, databases });
  } catch (err) {
    sendError(res, err, c);
  }
});

// Endpoint 2: list tables in a chosen database.
app.post('/api/tables', async (req, res) => {
  let c;
  try {
    c = parseCredentials(req.body || {}, { requireDatabase: true });

    let details;
    if (c.engine === 'mysql') {
      details = await withMysql(c, async (conn) => {
        const [rows] = await conn.query(
          `SELECT TABLE_SCHEMA AS \`schema\`, TABLE_NAME AS name, TABLE_TYPE AS type
             FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = ?
            ORDER BY TABLE_NAME`,
          [c.database]
        );
        return rows;
      });
    } else {
      details = await withMssql(c, async (pool) => {
        const r = await pool.request().query(
          `SELECT TABLE_SCHEMA AS [schema], TABLE_NAME AS name, TABLE_TYPE AS type
             FROM INFORMATION_SCHEMA.TABLES
            ORDER BY TABLE_SCHEMA, TABLE_NAME`
        );
        return r.recordset;
      });
    }

    const tables = details.map((t) => t.name);

    console.log(`\n[tables] ${c.engine} ${c.host}:${c.port} / ${c.database} — ${tables.length} table(s)`);
    console.table(details);

    res.json({ ok: true, database: c.database, count: tables.length, tables, details });
  } catch (err) {
    sendError(res, err, c);
  }
});

// Format an INFORMATION_SCHEMA.COLUMNS row from SQL Server as e.g. nvarchar(50), decimal(10,2).
function mssqlTypeLabel(col) {
  const t = col.DATA_TYPE;
  const len = col.CHARACTER_MAXIMUM_LENGTH;
  if (len != null) return `${t}(${len === -1 ? 'max' : len})`;
  if (['decimal', 'numeric'].includes(t)) return `${t}(${col.NUMERIC_PRECISION},${col.NUMERIC_SCALE})`;
  return t;
}

// Endpoint 3: column definitions + row count for one table.
app.post('/api/columns', async (req, res) => {
  let c;
  try {
    const body = req.body || {};
    c = parseCredentials(body, { requireDatabase: true });
    const table = String(body.table || '').trim();
    if (!table) throw new ValidationError('Table name is required.');
    // MySQL has no schemas inside a database; SQL Server defaults to dbo.
    const schema = c.engine === 'mysql' ? c.database : String(body.schema || 'dbo').trim();

    let columns;
    let rowCount = null;
    let rowCountError = null;

    if (c.engine === 'mysql') {
      ({ columns, rowCount, rowCountError } = await withMysql(c, async (conn) => {
        const [rows] = await conn.query(
          `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
                  COLUMN_KEY AS \`key\`, COLUMN_DEFAULT AS \`default\`, EXTRA AS extra
             FROM INFORMATION_SCHEMA.COLUMNS
            WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
            ORDER BY ORDINAL_POSITION`,
          [c.database, table]
        );
        if (!rows.length) return { columns: rows };

        let count = null;
        let countErr = null;
        try {
          // Identifiers can't be bound as parameters; escapeId quotes them safely.
          const [[r]] = await conn.query({
            sql: `SELECT COUNT(*) AS n FROM ${mysql.escapeId(c.database)}.${mysql.escapeId(table)}`,
            timeout: 15000,
          });
          count = Number(r.n);
        } catch (e) {
          countErr = e.message;
        }
        return {
          columns: rows.map((r) => ({
            name: r.name,
            type: r.type,
            nullable: r.nullable === 'YES',
            primaryKey: r.key === 'PRI',
            default: r.default,
            extra: r.extra || '',
          })),
          rowCount: count,
          rowCountError: countErr,
        };
      }));
    } else {
      ({ columns, rowCount, rowCountError } = await withMssql(c, async (pool) => {
        const r = await pool.request()
          .input('schema', sql.NVarChar, schema)
          .input('table', sql.NVarChar, table)
          .query(
            `SELECT c.COLUMN_NAME, c.DATA_TYPE, c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION,
                    c.NUMERIC_SCALE, c.IS_NULLABLE, c.COLUMN_DEFAULT,
                    COLUMNPROPERTY(OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)),
                                   c.COLUMN_NAME, 'IsIdentity') AS IS_IDENTITY,
                    CASE WHEN pk.COLUMN_NAME IS NULL THEN 0 ELSE 1 END AS IS_PK
               FROM INFORMATION_SCHEMA.COLUMNS c
               LEFT JOIN (
                    SELECT k.TABLE_SCHEMA, k.TABLE_NAME, k.COLUMN_NAME
                      FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
                      JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
                        ON k.CONSTRAINT_NAME = t.CONSTRAINT_NAME AND k.TABLE_SCHEMA = t.TABLE_SCHEMA
                     WHERE t.CONSTRAINT_TYPE = 'PRIMARY KEY'
               ) pk ON pk.TABLE_SCHEMA = c.TABLE_SCHEMA AND pk.TABLE_NAME = c.TABLE_NAME
                   AND pk.COLUMN_NAME = c.COLUMN_NAME
              WHERE c.TABLE_SCHEMA = @schema AND c.TABLE_NAME = @table
              ORDER BY c.ORDINAL_POSITION`
          );
        const rows = r.recordset;
        if (!rows.length) return { columns: rows };

        let count = null;
        let countErr = null;
        try {
          // Bracket-quote identifiers (] is escaped as ]]) since they can't be parameters.
          const q = (s) => `[${s.replace(/]/g, ']]')}]`;
          const cr = await pool.request().query(`SELECT COUNT_BIG(*) AS n FROM ${q(schema)}.${q(table)}`);
          count = Number(cr.recordset[0].n);
        } catch (e) {
          countErr = e.message;
        }
        return {
          columns: rows.map((row) => ({
            name: row.COLUMN_NAME,
            type: mssqlTypeLabel(row),
            nullable: row.IS_NULLABLE === 'YES',
            primaryKey: row.IS_PK === 1,
            default: row.COLUMN_DEFAULT,
            extra: row.IS_IDENTITY === 1 ? 'identity' : '',
          })),
          rowCount: count,
          rowCountError: countErr,
        };
      }));
    }

    if (!columns.length) {
      return res.status(404).json({
        ok: false,
        error: { type: 'TABLE_NOT_FOUND', message: `Table "${schema}.${table}" was not found, or this user cannot see its columns.` },
      });
    }

    console.log(`\n[columns] ${c.engine} ${c.database} / ${schema}.${table} — ${columns.length} column(s), ${rowCount ?? '?'} row(s)`);
    console.table(columns);

    res.json({ ok: true, database: c.database, schema, table, rowCount, rowCountError, columns });
  } catch (err) {
    sendError(res, err, c);
  }
});

// Endpoint 4: bank / cash split for every employee who qualifies for a cash slip.
app.post('/api/cash-slips', async (req, res) => {
  let c;
  try {
    const body = req.body || {};
    c = parseCredentials(body, { requireDatabase: true });
    const table = String(body.table || '').trim();
    if (!table) throw new ValidationError('Table name is required.');
    const schema = c.engine === 'mysql' ? c.database : String(body.schema || 'dbo').trim();
    const cutoff = String(body.cutoff || DEFAULT_CUTOFF).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new ValidationError('Cut-off date must be YYYY-MM-DD.');

    let rows;
    let columnNames;
    if (c.engine === 'mysql') {
      // dateStrings keeps DOJ/DOS as plain YYYY-MM-DD, avoiding timezone shifts.
      ({ rows, columnNames } = await withMysql(c, async (conn) => {
        const [r, fields] = await conn.query({
          sql: `SELECT * FROM ${mysql.escapeId(c.database)}.${mysql.escapeId(table)}`,
          timeout: 30000,
        });
        return { rows: r, columnNames: fields.map((f) => f.name) };
      }, { dateStrings: true }));
    } else {
      ({ rows, columnNames } = await withMssql(c, async (pool) => {
        const q = (s) => `[${s.replace(/]/g, ']]')}]`;
        const r = await pool.request().query(`SELECT * FROM ${q(schema)}.${q(table)}`);
        return { rows: r.recordset, columnNames: Object.keys(r.recordset.columns || {}) };
      }));
    }

    const missing = missingColumns(columnNames);
    if (missing.length) {
      throw new ValidationError(`Table "${table}" is missing column(s) ${missing.join(', ')}. Cash slips need ${REQUIRED.join(', ')}.`);
    }

    const result = buildCashSlips(rows, { cutoff });
    const s = result.summary;
    console.log(`\n[cash-slips] ${c.database} / ${table} — ${s.totalRows} row(s), ${s.qualified} qualified, ${s.withCash} with cash (cut-off ${cutoff})`);

    res.json({ ok: true, database: c.database, table, ...result });
  } catch (err) {
    if (err && /cash_ratios\.json/.test(err.message || '')) {
      return res.status(500).json({ ok: false, error: { type: 'RATIO_FILE', severity: 'warning', message: err.message } });
    }
    sendError(res, err, c);
  }
});

// Malformed JSON bodies.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') {
    return res.status(400).json({ ok: false, error: { type: 'VALIDATION_ERROR', severity: 'warning', message: 'Request body is not valid JSON.' } });
  }
  next(err);
});

app.listen(PORT, HOST, () => {
  console.log(`DB Explorer running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}`);
});
