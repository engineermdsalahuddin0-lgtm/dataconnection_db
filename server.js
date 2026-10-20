'use strict';

const path = require('path');
const express = require('express');
const mysql = require('mysql2/promise');
const sql = require('mssql');
const { buildCashSlips, DEFAULT_CUTOFF } = require('./cash-slip');
const salarySource = require('./salary-source');
const savedConnection = require('./saved-connection');
const savedQueries = require('./saved-queries');

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
const READ_ENDPOINTS = new Set(['/api/connect', '/api/tables', '/api/columns', '/api/export-schema','/api/salary-source', '/api/cash-slips', '/api/query-slips', '/api/distinct-values', '/api/run-query']);
// These write ONLY to local files in data/ (saved connection, saved queries), never to the database.
const LOCAL_SETTINGS_ENDPOINTS = new Set(['/api/saved-connection', '/api/saved-connection/last', '/api/saved-connection/forget', '/api/saved-queries/save', '/api/saved-queries/delete']);
const POST_ALLOWED = new Set([...READ_ENDPOINTS, ...LOCAL_SETTINGS_ENDPOINTS]);

const app = express();
app.use((req, res, next) => {
  if (req.method === 'GET' || req.method === 'HEAD') return next();
  if (req.method === 'POST' && POST_ALLOWED.has(req.path)) return next();
  res.set('Allow', POST_ALLOWED.has(req.path) ? 'POST' : 'GET, HEAD');
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
    requestTimeout: 30000,
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
 *   1. Every statement must be a single SELECT (or WITH ... SELECT / SHOW), checked by
 *      assertReadOnly before it is sent. This also covers queries typed in the Query box.
 *   2. MySQL sessions are switched to READ ONLY, so the server itself rejects any write.
 *   3. SQL Server work runs inside a transaction that is always rolled back, never committed.
 * Route handlers only ever see the guarded wrappers below, never the raw connection.
 */
class ReadOnlyError extends Error {}

/**
 * Splits SQL into
 *   clean: the text with -- and /* *\/ comments removed (strings and [names] kept), and
 *   code:  the same with every string literal emptied, so keywords inside strings
 *          ('...delete...') or a ';' in a value never trip the checks.
 */
function scanSql(text) {
  const src = String(text || '');
  let clean = '';
  let code = '';
  for (let i = 0; i < src.length;) {
    const ch = src[i];
    const two = src.slice(i, i + 2);
    if (two === '--') {
      const nl = src.indexOf('\n', i);
      i = nl < 0 ? src.length : nl;
      clean += ' ';
      code += ' ';
    } else if (two === '/*') {
      const end = src.indexOf('*/', i + 2);
      i = end < 0 ? src.length : end + 2;
      clean += ' ';
      code += ' ';
    } else if (ch === "'" || ch === '"' || ch === '[' || ch === '`') {
      const close = ch === '[' ? ']' : ch;
      let j = i + 1;
      for (; j < src.length; j++) {
        if (src[j] === close) {
          if (src[j + 1] === close) { j++; continue; } // doubled quote = escaped
          break;
        }
      }
      const literal = src.slice(i, j + 1);
      clean += literal;
      // String values are blanked for the checks; quoted identifiers keep a neutral placeholder.
      code += ch === "'" ? "''" : ' x ';
      i = j + 1;
    } else {
      clean += ch;
      code += ch;
      i++;
    }
  }
  return { clean: clean.trim(), code };
}

// Any of these anywhere in the statement (outside strings and comments) is refused.
const WRITE_WORDS = /\b(INSERT|UPDATE|DELETE|MERGE|UPSERT|REPLACE\s+INTO|DROP|ALTER|CREATE|TRUNCATE|RENAME|GRANT|REVOKE|DENY|EXEC|EXECUTE|CALL|DECLARE|SET|USE|BACKUP|RESTORE|DBCC|KILL|SHUTDOWN|BULK|OPENROWSET|OPENQUERY|OPENDATASOURCE|LOAD\s+DATA|HANDLER|LOCK|UNLOCK)\b/i;

/** Throws ReadOnlyError unless text is one read-only statement. Returns the comment-free SQL to send. */
function assertReadOnly(text) {
  const { clean, code } = scanSql(text);
  const body = code.trim();
  const word = (body.match(WRITE_WORDS) || [])[1];
  const problem =
    !body ? 'the query is empty' :
    !/^(SELECT|SHOW|WITH)\b/i.test(body) ? 'only SELECT queries are allowed' :
    /;\s*\S/.test(body) ? 'multiple statements are not allowed' :
    /\bINTO\b/i.test(body) ? 'SELECT ... INTO writes data and is not allowed' :
    /\bFOR\s+UPDATE\b/i.test(body) ? 'locking reads (FOR UPDATE) are not allowed' :
    word ? `"${word.toUpperCase()}" is not allowed in a read-only query` :
    null;
  if (problem) throw new ReadOnlyError(`Blocked by read-only mode: ${problem}.`);
  return clean.replace(/;\s*$/, '');
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
      /** Runs a user-typed SELECT, returning at most `limit` rows. */
      async queryLimited(text, limit) {
        const safe = assertReadOnly(text);
        await conn.query(`SET SESSION sql_select_limit = ${Number(limit) | 0}`);
        const [rows, fields] = await conn.query({ sql: safe, timeout: 30000 });
        return { rows, columns: (fields || []).map((f) => f.name) };
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
      /** Runs a user-typed SELECT, returning at most `limit` rows (SET ROWCOUNT caps it server side). */
      async queryLimited(text, limit) {
        const safe = assertReadOnly(text);
        const r = new sql.Request(tx);
        const res = await r.query(`SET ROWCOUNT ${Number(limit) | 0};\n${safe}`);
        return { rows: res.recordset || [], columns: Object.keys((res.recordset && res.recordset.columns) || {}) };
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
    c = parseCredentials(await savedConnection.resolve(req.body || {}));
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
    c = parseCredentials(await savedConnection.resolve(req.body || {}), { requireDatabase: true });

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
    const body = await savedConnection.resolve(req.body || {});
    c = parseCredentials(body, { requireDatabase: true });
    const table = String(body.table || '').trim();
    if (!table) throw new ValidationError('Table name is required.');
    // MySQL has no schemas inside a database; SQL Server defaults to dbo.
    const schema = c.engine === 'mysql' ? c.database : String(body.schema || 'dbo').trim();
    const noCount = Boolean(body.noCount); // skip COUNT(*) when only the column names are needed

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
        if (!noCount) try {
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
        if (!noCount) try {
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

/*
 * Schema-only export. The CREATE TABLE script is assembled here from INFORMATION_SCHEMA
 * reads (SHOW CREATE / sp_helptext would trip the read-only guard), so no data is read
 * and nothing is run on the server except SELECTs.
 */
function groupBy(rows, key) {
  const m = new Map();
  for (const r of rows) {
    const k = key(r);
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return m;
}

/** Groups key-column rows into constraints: { name, table, columns, refTable, refColumns, rule }. */
function constraintsOf(rows) {
  return [...groupBy(rows, (r) => `${r.tbl}\0${r.cname}`).values()].map((cols) => ({
    name: cols[0].cname,
    table: cols[0].tbl,
    columns: cols.map((r) => r.col),
    refTable: cols[0].ref_tbl,
    refColumns: cols.map((r) => r.ref_col),
    onDelete: cols[0].del_rule,
    onUpdate: cols[0].upd_rule,
  }));
}

function buildSchemaScript(c, { tables, columns, keys, uniques, fks }, q) {
  const cols = groupBy(columns, (r) => r.tbl);
  const pk = new Map(constraintsOf(keys).map((k) => [k.table, k]));
  const uq = groupBy(constraintsOf(uniques), (k) => k.table);
  const rule = (r) => (r && r !== 'NO ACTION' && r !== 'RESTRICT' ? r : null);

  const out = [
    `-- Schema export of ${c.engine === 'mysql' ? 'MySQL' : 'SQL Server'} database "${c.database}" on ${c.host}:${c.port}`,
    `-- ${tables.length} table(s), structure only (no data). Generated ${new Date().toISOString()}`,
    '',
  ];
  for (const t of tables) {
    const lines = (cols.get(t.tbl) || []).map((col) => {
      let s = `  ${q(col.name)} ${col.type}`;
      if (col.extra) s += ` ${col.extra}`;
      s += col.nullable === 'YES' ? ' NULL' : ' NOT NULL';
      if (col.dflt != null) s += ` DEFAULT ${col.dflt}`;
      return s;
    });
    const p = pk.get(t.tbl);
    if (p) lines.push(`  CONSTRAINT ${q(p.name)} PRIMARY KEY (${p.columns.map(q).join(', ')})`);
    for (const u of uq.get(t.tbl) || []) lines.push(`  CONSTRAINT ${q(u.name)} UNIQUE (${u.columns.map(q).join(', ')})`);
    out.push(`CREATE TABLE ${t.label} (`, lines.join(',\n'), ');', '');
  }

  const foreign = constraintsOf(fks);
  if (foreign.length) out.push('-- Foreign keys', '');
  for (const f of foreign) {
    let s = `ALTER TABLE ${f.table} ADD CONSTRAINT ${q(f.name)} FOREIGN KEY (${f.columns.map(q).join(', ')}) ` +
      `REFERENCES ${f.refTable} (${f.refColumns.map(q).join(', ')})`;
    if (rule(f.onDelete)) s += ` ON DELETE ${f.onDelete}`;
    if (rule(f.onUpdate)) s += ` ON UPDATE ${f.onUpdate}`;
    out.push(s + ';');
  }
  return out.join('\n') + '\n';
}

// Endpoint 4: CREATE TABLE script (structure only) for every base table in a database.
app.post('/api/export-schema', async (req, res) => {
  let c;
  try {
    c = parseCredentials(await savedConnection.resolve(req.body || {}), { requireDatabase: true });

    let script;
    if (c.engine === 'mysql') {
      const q = (s) => mysql.escapeId(String(s));
      script = await withMysql(c, async (conn) => {
        const db = [c.database];
        const [tables] = await conn.query(
          `SELECT TABLE_NAME AS tbl FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_SCHEMA = ? AND TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_NAME`, db);
        const [columns] = await conn.query(
          `SELECT TABLE_NAME AS tbl, COLUMN_NAME AS name, COLUMN_TYPE AS type, IS_NULLABLE AS nullable,
                  COLUMN_DEFAULT AS dflt, DATA_TYPE AS dtype, EXTRA AS extra
             FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME, ORDINAL_POSITION`, db);
        const keyCols = (type) => conn.query(
          `SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS cname, k.COLUMN_NAME AS col
             FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
               ON k.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND k.TABLE_NAME = t.TABLE_NAME AND k.CONSTRAINT_NAME = t.CONSTRAINT_NAME
            WHERE t.TABLE_SCHEMA = ? AND t.CONSTRAINT_TYPE = ? ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
          [c.database, type]).then(([r]) => r);
        const [fks] = await conn.query(
          `SELECT k.TABLE_NAME AS tbl, k.CONSTRAINT_NAME AS cname, k.COLUMN_NAME AS col,
                  k.REFERENCED_TABLE_NAME AS ref_tbl, k.REFERENCED_COLUMN_NAME AS ref_col,
                  r.DELETE_RULE AS del_rule, r.UPDATE_RULE AS upd_rule
             FROM INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
             JOIN INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS r
               ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME
            WHERE k.TABLE_SCHEMA = ? ORDER BY k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`, db);

        const textual = /char|text|enum|set|date|time|year|binary|blob|json/i;
        return buildSchemaScript(c, {
          tables: tables.map((t) => ({ ...t, label: q(t.tbl) })),
          columns: columns.map((col) => ({
            ...col,
            // MySQL reports defaults unquoted; quote literal values, keep expressions as-is.
            dflt: col.dflt == null ? null
              : /^(CURRENT_TIMESTAMP|NULL)\b/i.test(col.dflt) ? col.dflt
              : /DEFAULT_GENERATED/.test(col.extra) ? `(${col.dflt})`
              : textual.test(col.dtype) ? mysql.escape(col.dflt) : col.dflt,
            extra: String(col.extra || '').replace(/\bDEFAULT_GENERATED\b/i, '').trim(),
          })),
          keys: await keyCols('PRIMARY KEY'),
          uniques: await keyCols('UNIQUE'),
          fks: fks.map((f) => ({ ...f, tbl: q(f.tbl), ref_tbl: q(f.ref_tbl) })),
        }, q);
      });
    } else {
      const q = (s) => `[${String(s).replace(/]/g, ']]')}]`;
      script = await withMssql(c, async (pool) => {
        const run = async (text) => (await pool.request().query(text)).recordset;
        // tbl is always the bracketed schema.table, so names line up across the queries.
        const tables = await run(
          `SELECT QUOTENAME(TABLE_SCHEMA) + '.' + QUOTENAME(TABLE_NAME) AS tbl FROM INFORMATION_SCHEMA.TABLES
            WHERE TABLE_TYPE = 'BASE TABLE' ORDER BY TABLE_SCHEMA, TABLE_NAME`);
        const columns = await run(
          `SELECT QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME) AS tbl, c.COLUMN_NAME AS name, c.DATA_TYPE,
                  c.CHARACTER_MAXIMUM_LENGTH, c.NUMERIC_PRECISION, c.NUMERIC_SCALE, c.DATETIME_PRECISION,
                  c.IS_NULLABLE AS nullable, c.COLUMN_DEFAULT AS dflt,
                  ic.seed_value, ic.increment_value
             FROM INFORMATION_SCHEMA.COLUMNS c
             LEFT JOIN sys.identity_columns ic
               ON ic.object_id = OBJECT_ID(QUOTENAME(c.TABLE_SCHEMA) + '.' + QUOTENAME(c.TABLE_NAME)) AND ic.name = c.COLUMN_NAME
            ORDER BY c.TABLE_SCHEMA, c.TABLE_NAME, c.ORDINAL_POSITION`);
        const keyCols = (type) => run(
          `SELECT QUOTENAME(k.TABLE_SCHEMA) + '.' + QUOTENAME(k.TABLE_NAME) AS tbl, k.CONSTRAINT_NAME AS cname, k.COLUMN_NAME AS col
             FROM INFORMATION_SCHEMA.TABLE_CONSTRAINTS t
             JOIN INFORMATION_SCHEMA.KEY_COLUMN_USAGE k
               ON k.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND k.CONSTRAINT_NAME = t.CONSTRAINT_NAME
            WHERE t.CONSTRAINT_TYPE = '${type}' ORDER BY k.TABLE_SCHEMA, k.TABLE_NAME, k.CONSTRAINT_NAME, k.ORDINAL_POSITION`);
        const fks = await run(
          `SELECT QUOTENAME(SCHEMA_NAME(f.schema_id)) + '.' + QUOTENAME(OBJECT_NAME(f.parent_object_id)) AS tbl,
                  f.name AS cname, COL_NAME(fc.parent_object_id, fc.parent_column_id) AS col,
                  QUOTENAME(OBJECT_SCHEMA_NAME(f.referenced_object_id)) + '.' + QUOTENAME(OBJECT_NAME(f.referenced_object_id)) AS ref_tbl,
                  COL_NAME(fc.referenced_object_id, fc.referenced_column_id) AS ref_col,
                  REPLACE(f.delete_referential_action_desc, '_', ' ') AS del_rule,
                  REPLACE(f.update_referential_action_desc, '_', ' ') AS upd_rule
             FROM sys.foreign_keys f
             JOIN sys.foreign_key_columns fc ON fc.constraint_object_id = f.object_id
            ORDER BY tbl, f.name, fc.constraint_column_id`);

        return buildSchemaScript(c, {
          tables: tables.map((t) => ({ ...t, label: t.tbl })),
          columns: columns.map((col) => {
            const t = col.DATA_TYPE;
            // text/ntext/image/xml report a length but take none in DDL.
            let type = ['text', 'ntext', 'image', 'xml'].includes(t) ? t : mssqlTypeLabel(col);
            if (['datetime2', 'time', 'datetimeoffset'].includes(t) && col.DATETIME_PRECISION != null) type = `${t}(${col.DATETIME_PRECISION})`;
            if (['float'].includes(t) && col.NUMERIC_PRECISION != null && col.NUMERIC_PRECISION !== 53) type = `${t}(${col.NUMERIC_PRECISION})`;
            return { ...col, type, extra: col.seed_value != null ? `IDENTITY(${col.seed_value},${col.increment_value})` : '' };
          }),
          keys: await keyCols('PRIMARY KEY'),
          uniques: await keyCols('UNIQUE'),
          fks,
        }, q);
      });
    }

    console.log(`\n[export-schema] ${c.engine} ${c.host}:${c.port} / ${c.database} — ${script.length} chars`);
    const file = `${c.database.replace(/[^\w-]+/g, '_')}_schema.sql`;
    res.set('Content-Type', 'application/sql; charset=utf-8');
    res.set('Content-Disposition', `attachment; filename="${file}"`);
    res.send(script);
  } catch (err) {
    sendError(res, err, c);
  }
});

/**
 * Runs fn({ q, param, run }) on a guarded read-only connection.
 *   q(name)          quotes an identifier for the engine
 *   param            placeholder for the single bound value ('?' or '@proc')
 *   run(sql, value)  runs one SELECT and resolves to its rows
 */
async function withReader(c, fn) {
  if (c.engine === 'mysql') {
    // dateStrings keeps DOJ/DOS as plain YYYY-MM-DD, avoiding timezone shifts.
    return withMysql(c, (conn) => fn({
      q: (name) => mysql.escapeId(String(name)),
      param: '?',
      run: async (text, value) => (await conn.query({ sql: text, timeout: 30000 }, value === undefined ? [] : [value]))[0],
      queryLimited: (text, limit) => conn.queryLimited(text, limit),
    }), { dateStrings: true });
  }
  return withMssql(c, (pool) => fn({
    q: (name) => `[${String(name).replace(/]/g, ']]')}]`,
    param: '@proc',
    run: async (text, value) => {
      const r = pool.request();
      if (value !== undefined) r.input('proc', sql.VarChar(100), String(value));
      return (await r.query(text)).recordset;
    },
    queryLimited: (text, limit) => pool.queryLimited(text, limit),
  }));
}

/** Finds MonthWiseSalaryInfo / MonthWiseSalaryInfoExt and resolves the columns the slip needs. */
async function loadSalarySource(reader, c) {
  const { q, run } = reader;
  const names = `'${salarySource.INFO}', '${salarySource.EXT}'`;
  const text = `SELECT TABLE_SCHEMA AS ${q('schema')}, TABLE_NAME AS ${q('table')}, COLUMN_NAME AS ${q('column')}
  FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_NAME IN (${names})${c.engine === 'mysql' ? ' AND TABLE_SCHEMA = ?' : ''}
 ORDER BY ORDINAL_POSITION`;
  const rows = await run(text, c.engine === 'mysql' ? c.database : undefined);
  const tables = salarySource.pickTables(rows);
  return { tables, resolved: salarySource.resolveColumns(tables) };
}

function describeMissing(resolved) {
  if (resolved.tablesMissing && resolved.tablesMissing.length) {
    return `Table(s) not found in this database: ${resolved.tablesMissing.join(', ')}.`;
  }
  const parts = [];
  if (resolved.missing.info.length) parts.push(`${salarySource.INFO} is missing ${resolved.missing.info.join(', ')}`);
  if (resolved.missing.ext.length) parts.push(`${salarySource.EXT} is missing ${resolved.missing.ext.join(', ')}`);
  return parts.join('; ') + '.';
}

// Endpoint 4: is the month-wise salary source here, and which salary months (SalaryProcID) exist?
app.post('/api/salary-source', async (req, res) => {
  let c;
  try {
    c = parseCredentials(await savedConnection.resolve(req.body || {}), { requireDatabase: true });
    const out = await withReader(c, async (reader) => {
      const { tables, resolved } = await loadSalarySource(reader, c);
      const found = Boolean(tables.info && tables.ext);
      let procs = [];
      if (resolved.ready) {
        const rows = await reader.run(salarySource.buildProcListQuery(tables, resolved.map, reader.q));
        procs = rows.map((r) => ({ id: String(r.id), rows: Number(r.n) }));
      }
      return {
        found,
        ready: resolved.ready,
        message: resolved.ready ? null : describeMissing(resolved),
        warnings: resolved.warnings,
        tables: found ? { info: `${tables.info.schema}.${tables.info.name}`, ext: `${tables.ext.schema}.${tables.ext.name}` } : null,
        procs,
      };
    });
    res.json({ ok: true, database: c.database, ...out });
  } catch (err) {
    sendError(res, err, c);
  }
});

// Endpoint 5: bank / cash split for one salary month, from MonthWiseSalaryInfo + Ext.
app.post('/api/cash-slips', async (req, res) => {
  let c;
  try {
    const body = await savedConnection.resolve(req.body || {});
    c = parseCredentials(body, { requireDatabase: true });
    const salaryProcId = String(body.salaryProcId || '').trim();
    if (!salaryProcId) throw new ValidationError('Pick a salary month (SalaryProcID).');
    const cutoff = String(body.cutoff || DEFAULT_CUTOFF).trim();
    if (!/^d{4}-d{2}-d{2}$/.test(cutoff)) throw new ValidationError('Cut-off date must be YYYY-MM-DD.');

    const { rows, warnings, tables } = await withReader(c, async (reader) => {
      const { tables: t, resolved } = await loadSalarySource(reader, c);
      if (!resolved.ready) throw new ValidationError(describeMissing(resolved));
      const text = salarySource.buildSlipQuery(t, resolved.map, reader.q, reader.param);
      return { rows: await reader.run(text, salaryProcId), warnings: resolved.warnings, tables: t };
    });
    if (!rows.length) {
      throw new ValidationError(`No rows for SalaryProcID "${salaryProcId}" in ${salarySource.INFO} joined with ${salarySource.EXT}.`);
    }

    const result = buildCashSlips(rows, { cutoff });
    const s = result.summary;
    console.log(`
[cash-slips] ${c.database} SalaryProcID ${salaryProcId} — ${s.totalRows} row(s), ${s.qualified} qualified, ${s.withCash} with cash (cut-off ${cutoff})`);

    res.json({
      ok: true,
      database: c.database,
      source: `${tables.info.name} + ${tables.ext.name}`,
      salaryProcId,
      warnings,
      ...result,
    });
  } catch (err) {
    if (err && /cash_ratios.json/.test(err.message || '')) {
      return res.status(500).json({ ok: false, error: { type: 'RATIO_FILE', severity: 'warning', message: err.message } });
    }
    sendError(res, err, c);
  }
});

// Endpoint 8: run any read-only SELECT and return the raw rows (SQL query tab).
const RUN_ROW_LIMIT = 1000;

/** Makes a DB value JSON-safe for display: dates as ISO text, binary as short hex. */
function displayValue(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString().replace('T00:00:00.000Z', '').replace('.000Z', 'Z');
  if (Buffer.isBuffer(v)) return `0x${v.subarray(0, 32).toString('hex')}${v.length > 32 ? '…' : ''}`;
  if (typeof v === 'bigint') return v.toString();
  return v;
}

app.post('/api/run-query', async (req, res) => {
  let c;
  try {
    const body = await savedConnection.resolve(req.body || {});
    c = parseCredentials(body, { requireDatabase: true });
    const text = String(body.sql || '');
    if (!text.trim()) throw new ValidationError('Write or paste a SELECT query first.');
    if (text.length > 20000) throw new ValidationError('The query is too long (max 20,000 characters).');
    assertReadOnly(text); // refuse writes before even connecting (checked again when it runs)

    const started = Date.now();
    const { rows, columns } = await withReader(c, (reader) => reader.queryLimited(text, RUN_ROW_LIMIT + 1));
    const ms = Date.now() - started;
    const names = columns.length ? columns : Object.keys(rows[0] || {});
    const truncated = rows.length > RUN_ROW_LIMIT;
    const out = rows.slice(0, RUN_ROW_LIMIT).map((r) => names.map((n) => displayValue(r[n])));
    console.log(`\n[run-query] ${c.database} — ${out.length}${truncated ? '+' : ''} row(s) in ${ms} ms`);
    res.json({ ok: true, columns: names, rows: out, truncated, limit: RUN_ROW_LIMIT, ms });
  } catch (err) {
    sendError(res, err, c);
  }
});

// Endpoint 7: distinct values of one column with row counts, newest first (salary month list
// for the Manual mapping panel). The table and column are checked against INFORMATION_SCHEMA first.
app.post('/api/distinct-values', async (req, res) => {
  let c;
  try {
    const body = await savedConnection.resolve(req.body || {});
    c = parseCredentials(body, { requireDatabase: true });
    const table = String(body.table || '').trim();
    const column = String(body.column || '').trim();
    if (!table || !column) throw new ValidationError('Table and column are required.');
    const schema = c.engine === 'mysql' ? c.database : String(body.schema || 'dbo').trim();

    const values = await withReader(c, async ({ q, run }) => {
      const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
      const cols = await run(`SELECT COLUMN_NAME AS ${q('name')} FROM INFORMATION_SCHEMA.COLUMNS
 WHERE TABLE_SCHEMA = ${lit(schema)} AND TABLE_NAME = ${lit(table)}`);
      const real = cols.map((r) => r.name).find((n) => n.toLowerCase() === column.toLowerCase());
      if (!real) throw new ValidationError(`Column "${column}" was not found in ${schema}.${table}.`);
      const from = c.engine === 'mysql' ? q(table) : `${q(schema)}.${q(table)}`;
      const col = q(real);
      const rows = await run(c.engine === 'mysql'
        ? `SELECT ${col} AS ${q('id')}, COUNT(*) AS ${q('n')} FROM ${from} GROUP BY ${col} ORDER BY ${col} DESC LIMIT 500`
        : `SELECT TOP 500 ${col} AS ${q('id')}, COUNT(*) AS ${q('n')} FROM ${from} GROUP BY ${col} ORDER BY ${col} DESC`);
      return rows.filter((r) => r.id != null).map((r) => ({ id: String(r.id), rows: Number(r.n) }));
    });
    res.json({ ok: true, values });
  } catch (err) {
    sendError(res, err, c);
  }
});

// Endpoint 6: cash split for the rows a user-typed SELECT returns (Query box).
const QUERY_ROW_LIMIT = 5000;
const QUERY_REQUIRED = ['EmployeeCode', 'EmployeeName', 'Designation', 'OrgGross', 'OrgBasic', 'OrgHouseRent', 'OrgMedical', 'OrgConvence', 'DOJ'];
const QUERY_OPTIONAL = ['DOS', 'DisplayEmployeeCode', 'Department', 'Unit', 'SalaryProcID'];

app.post('/api/query-slips', async (req, res) => {
  let c;
  try {
    const body = await savedConnection.resolve(req.body || {});
    c = parseCredentials(body, { requireDatabase: true });
    const text = String(body.sql || '');
    if (!text.trim()) throw new ValidationError('Write or paste a SELECT query first.');
    if (text.length > 20000) throw new ValidationError('The query is too long (max 20,000 characters).');
    assertReadOnly(text); // refuse writes before even connecting (checked again when it runs)
    const cutoff = String(body.cutoff || DEFAULT_CUTOFF).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(cutoff)) throw new ValidationError('Cut-off date must be YYYY-MM-DD.');

    // One extra row tells us the limit was hit.
    const { rows, columns } = await withReader(c, (reader) => reader.queryLimited(text, QUERY_ROW_LIMIT + 1));
    if (rows.length > QUERY_ROW_LIMIT) {
      throw new ValidationError(`The query returned more than ${QUERY_ROW_LIMIT.toLocaleString()} rows. Narrow it with WHERE (for example one SalaryProcID).`);
    }

    const have = new Map((columns.length ? columns : Object.keys(rows[0] || {})).map((n) => [n.toLowerCase(), n]));
    const missing = QUERY_REQUIRED.filter((n) => !have.has(n.toLowerCase()));
    if (missing.length) {
      throw new ValidationError(`The query ran, but its result is missing column(s): ${missing.join(', ')}. Rename with AS, e.g. "e.DesigName AS Designation".`);
    }
    const warnings = [];
    if (!have.has('dos')) warnings.push('No DOS column in the result: inactive (separated) employees cannot be excluded.');

    // Copy only the known columns, so a stray column such as BASIC can never shadow OrgBasic.
    const pick = (row, name) => row[have.get(name.toLowerCase())];
    const mapped = rows.map((row) => {
      const out = {
        Gross: pick(row, 'OrgGross'),
        Basic: pick(row, 'OrgBasic'),
        HouseRent: pick(row, 'OrgHouseRent'),
        Medical: pick(row, 'OrgMedical'),
        Conveyance: pick(row, 'OrgConvence'),
      };
      for (const n of ['EmployeeCode', 'EmployeeName', 'Designation', 'DOJ', ...QUERY_OPTIONAL]) {
        if (have.has(n.toLowerCase())) out[n] = pick(row, n);
      }
      return out;
    });

    const result = buildCashSlips(mapped, { cutoff });
    const s = result.summary;
    console.log(`\n[query-slips] ${c.database} — ${s.totalRows} row(s), ${s.qualified} qualified, ${s.withCash} with cash (cut-off ${cutoff})`);
    res.json({ ok: true, database: c.database, warnings, columns, ...result });
  } catch (err) {
    if (err && /cash_ratios\.json/.test(err.message || '')) {
      return res.status(500).json({ ok: false, error: { type: 'RATIO_FILE', severity: 'warning', message: err.message } });
    }
    sendError(res, err, c);
  }
});

/* Saved queries (SQL query tab): local file only (data/saved-queries.json). */

app.get('/api/saved-queries', (req, res) => {
  res.json({ ok: true, queries: savedQueries.list() });
});

app.post('/api/saved-queries/save', (req, res) => {
  try {
    const b = req.body || {};
    const query = savedQueries.save({ id: b.id, name: b.name, sql: b.sql, database: b.database }, assertReadOnly);
    console.log(`[saved-queries] saved "${query.name}"`);
    res.json({ ok: true, query, queries: savedQueries.list() });
  } catch (err) {
    if (err instanceof savedQueries.SavedQueryError) {
      return res.status(400).json({ ok: false, error: { type: 'VALIDATION_ERROR', severity: 'warning', message: err.message } });
    }
    console.warn(`[warning] SAVE_QUERY_FAILED: ${err.message}`);
    res.status(500).json({ ok: false, error: { type: 'SAVE_FAILED', severity: 'warning', message: `Could not save the query: ${err.message}` } });
  }
});

app.post('/api/saved-queries/delete', (req, res) => {
  const removed = savedQueries.remove(String((req.body || {}).id || ''));
  res.json({ ok: true, removed, queries: savedQueries.list() });
});

/* Remember-me: local file only (data/connection.json). The password is never sent back. */

app.get('/api/saved-connection', (req, res) => {
  res.json({ ok: true, saved: savedConnection.getPublic() });
});

app.post('/api/saved-connection', async (req, res) => {
  try {
    const body = req.body || {};
    // Re-saving from an auto-connected session keeps the already saved password.
    const c = parseCredentials(await savedConnection.resolve(body));
    await savedConnection.save(c, { keepPassword: Boolean(body.useSaved) });
    console.log(`[saved-connection] saved ${c.engine} ${c.user}@${c.host}:${c.port}`);
    res.json({ ok: true, saved: savedConnection.getPublic() });
  } catch (err) {
    if (err instanceof ValidationError) return sendError(res, err);
    console.warn(`[warning] SAVE_FAILED: ${err.message}`);
    res.status(500).json({ ok: false, error: { type: 'SAVE_FAILED', severity: 'warning', message: `Could not save the connection: ${err.message}` } });
  }
});

app.post('/api/saved-connection/last', (req, res) => {
  const b = req.body || {};
  const stored = savedConnection.rememberLast({ database: b.database, table: b.table, schema: b.schema });
  res.json({ ok: true, stored });
});

app.post('/api/saved-connection/forget', (req, res) => {
  savedConnection.forget();
  console.log('[saved-connection] forgotten');
  res.json({ ok: true });
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
