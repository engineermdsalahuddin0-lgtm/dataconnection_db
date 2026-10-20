'use strict';

/*
 * Remembers one DB connection in data/connection.json (git-ignored) so the app can
 * reconnect on start-up. The password is encrypted with Windows DPAPI (CurrentUser
 * scope): only the same Windows user on the same machine can decrypt it. The
 * password never goes back to the browser; the server fills it in when a request
 * says `useSaved: true`.
 *
 * This writes only to the local file above, never to the database.
 */

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const FILE = path.join(__dirname, 'data', 'connection.json');
const FIELDS = ['engine', 'host', 'port', 'user', 'database', 'encrypt', 'hideSystem'];

let passwordCache = null; // { cipher, plain } so DPAPI runs once per server start

/** Runs a PowerShell snippet with `input` on stdin (keeps secrets off the command line). */
function powershell(script, input) {
  if (process.platform !== 'win32') {
    return Promise.reject(new Error('Saving the password needs Windows (DPAPI).'));
  }
  const prelude = '$ErrorActionPreference="Stop";[Console]::InputEncoding=[Text.Encoding]::UTF8;[Console]::OutputEncoding=[Text.Encoding]::UTF8;';
  return new Promise((resolve, reject) => {
    const child = execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', prelude + script],
      { windowsHide: true, timeout: 15000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error(`DPAPI failed: ${(stderr || err.message).trim()}`));
        resolve(stdout);
      });
    child.stdin.end(input);
  });
}

const encrypt = (plain) => (plain === '' ? Promise.resolve('')
  : powershell('$p=[Console]::In.ReadToEnd();[Console]::Out.Write((ConvertTo-SecureString $p -AsPlainText -Force | ConvertFrom-SecureString))', plain)
    .then((s) => s.trim()));

const decrypt = (cipher) => (cipher === '' ? Promise.resolve('')
  : powershell('$s=ConvertTo-SecureString ([Console]::In.ReadToEnd().Trim());$b=[Runtime.InteropServices.Marshal]::SecureStringToBSTR($s);try{[Console]::Out.Write([Runtime.InteropServices.Marshal]::PtrToStringBSTR($b))}finally{[Runtime.InteropServices.Marshal]::ZeroFreeBSTR($b)}', cipher));

function readFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, 'utf8').replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

function writeFile(data) {
  fs.mkdirSync(path.dirname(FILE), { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify(data, null, 2));
}

/** What the browser may see: everything except the password. */
function getPublic() {
  const saved = readFile();
  if (!saved) return null;
  const out = {};
  for (const k of FIELDS) out[k] = saved[k];
  out.lastDatabase = saved.lastDatabase || null;
  out.lastTable = saved.lastTable || null;
  out.lastSchema = saved.lastSchema || null;
  out.savedAt = saved.savedAt;
  return out;
}

/**
 * Saves the connection. With keepPassword (the request used the saved password),
 * the existing encrypted password is kept instead of encrypting it again.
 */
async function save(creds, { keepPassword = false } = {}) {
  const prev = readFile();
  const plain = String(creds.password ?? '');
  const cipher = keepPassword && prev ? prev.password : await encrypt(plain);
  const data = { savedAt: new Date().toISOString() };
  for (const k of FIELDS) data[k] = creds[k] ?? null;
  data.password = cipher;
  // Keep the last opened database/table when it is still the same server and user.
  if (prev && prev.host === data.host && prev.user === data.user && prev.engine === data.engine) {
    for (const k of ['lastDatabase', 'lastTable', 'lastSchema']) data[k] = prev[k] || null;
  }
  writeFile(data);
  passwordCache = { cipher, plain };
}

/** Remembers the last opened database / table (no-op when nothing is saved). */
function rememberLast({ database, table, schema }) {
  const saved = readFile();
  if (!saved) return false;
  saved.lastDatabase = database || null;
  saved.lastTable = table || null;
  saved.lastSchema = schema || null;
  writeFile(saved);
  return true;
}

function forget() {
  passwordCache = null;
  try { fs.unlinkSync(FILE); } catch { /* already gone */ }
}

/** Returns body with the saved host/user/password filled in when body.useSaved is true. */
async function resolve(body) {
  if (!body || !body.useSaved) return body;
  const saved = readFile();
  if (!saved) throw new Error('No saved connection. Enter the details and connect again.');
  let plain;
  if (passwordCache && passwordCache.cipher === saved.password) {
    plain = passwordCache.plain;
  } else {
    plain = await decrypt(saved.password || '');
    passwordCache = { cipher: saved.password, plain };
  }
  const merged = { ...body };
  for (const k of ['engine', 'host', 'port', 'user', 'encrypt']) merged[k] = saved[k];
  merged.password = plain;
  return merged;
}

module.exports = { getPublic, save, rememberLast, forget, resolve };

