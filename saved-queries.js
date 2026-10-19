'use strict';

/*
 * Named SQL queries the user keeps for regular use (SQL query tab).
 * Stored on this PC only, in data/saved-queries.json (git-ignored). This writes
 * only to that local file, never to the database, and only SELECT queries are kept.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const FILE = path.join(__dirname, 'data', 'saved-queries.json');
const MAX_QUERIES = 200;
const MAX_NAME = 80;
const MAX_SQL = 20000;

class SavedQueryError extends Error {}

function readAll() {
  try {
    const json = JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
    return Array.isArray(json.queries) ? json.queries : [];
  } catch {
    return [];
  }
}

function writeAll(queries) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  // Write to a temp file first so a crash never leaves a half-written list.
  const tmp = `${FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ queries }, null, 2));
  fs.renameSync(tmp, FILE);
}

const byName = (a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true });

function list() {
  return readAll().sort(byName);
}

/**
 * Creates a query (no id) or updates one (with id). Names are unique, ignoring case.
 * `assertReadOnly` is the server's SQL guard, so a write query can never be stored.
 */
function save({ id, name, sql, database }, assertReadOnly) {
  const cleanName = String(name || '').trim();
  const text = String(sql || '');
  if (!cleanName) throw new SavedQueryError('Give the query a name.');
  if (cleanName.length > MAX_NAME) throw new SavedQueryError(`The name is too long (max ${MAX_NAME} characters).`);
  if (!text.trim()) throw new SavedQueryError('The query is empty.');
  if (text.length > MAX_SQL) throw new SavedQueryError(`The query is too long (max ${MAX_SQL.toLocaleString()} characters).`);
  try {
    assertReadOnly(text);
  } catch (err) {
    throw new SavedQueryError(`Only SELECT queries can be saved. ${err.message}`);
  }

  const queries = readAll();
  const clash = queries.find((q) => q.name.toLowerCase() === cleanName.toLowerCase() && q.id !== id);
  if (clash) throw new SavedQueryError(`A saved query named "${clash.name}" already exists. Pick another name.`);

  const now = new Date().toISOString();
  let entry = id ? queries.find((q) => q.id === id) : null;
  if (id && !entry) throw new SavedQueryError('That saved query no longer exists. Use "Save as new".');
  if (entry) {
    Object.assign(entry, { name: cleanName, sql: text, database: database || entry.database || null, updatedAt: now });
  } else {
    if (queries.length >= MAX_QUERIES) throw new SavedQueryError(`You can keep up to ${MAX_QUERIES} saved queries. Delete some first.`);
    entry = { id: crypto.randomUUID(), name: cleanName, sql: text, database: database || null, createdAt: now, updatedAt: now };
    queries.push(entry);
  }
  writeAll(queries);
  return entry;
}

function remove(id) {
  const queries = readAll();
  const next = queries.filter((q) => q.id !== id);
  if (next.length === queries.length) return false;
  writeAll(next);
  return true;
}

module.exports = { list, save, remove, SavedQueryError };
