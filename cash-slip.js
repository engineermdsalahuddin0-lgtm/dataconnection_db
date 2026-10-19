'use strict';

/*
 * Cash / bank salary split for cash slips.
 *
 * "Gross" is OrgGross from the salary table: the official (bank) gross. Each employee's
 * CashRatio (= ActualGross / OrgGross in the reference file) gives:
 *   bank   = OrgGross
 *   actual = OrgGross x ratio
 *   cash   = actual - OrgGross
 * Cash and bank are each split over Basic / HouseRent / Medical / Conveyance in the
 * proportion OrgBasic / OrgHouseRent / OrgMedical / OrgConvence have to OrgGross
 * (read per employee from the database). Basic takes the rounding remainder.
 * Ratio lookup: employee's own ratio -> designation average -> 1.0 (no cash).
 *
 * Eligibility, checked in this order:
 *   1. DOS present (any date)  -> not active, excluded
 *   2. joined before cut-off   -> actual gross >= 60,000
 *      joined on/after cut-off -> actual gross >= 100,000   (cut-off: 1 Sep 2026 by default)
 * The threshold is on the actual gross: in the July 2026 reference data every employee
 * with actual >= 60,000 has a ratio above 1 and everyone below has ratio 1.
 */

const fs = require('fs');
const path = require('path');

const RATIO_FILE = path.join(__dirname, 'data', 'cash_ratios.json');
const DEFAULT_CUTOFF = '2026-09-01';
const THRESHOLD_BEFORE = 60000;
const THRESHOLD_AFTER = 100000;

const COMPONENTS = ['Basic', 'HouseRent', 'Medical', 'Conveyance'];

const normCode = (v) => String(v == null ? '' : v).trim().replace(/^0+(?=\d)/, '');
const normDesig = (v) => String(v == null ? '' : v).toLowerCase().replace(/\./g, ' ').replace(/\s+/g, ' ').trim();

let cache = null;

/** Loads data/cash_ratios.json (reloaded when the file changes). */
function loadRatios() {
  let stat;
  try {
    stat = fs.statSync(RATIO_FILE);
  } catch {
    throw new Error('Cash ratio file data/cash_ratios.json is missing. Run scripts\\build-cash-ratios.ps1 first.');
  }
  if (cache && cache.mtimeMs === stat.mtimeMs) return cache;

  const json = JSON.parse(fs.readFileSync(RATIO_FILE, 'utf8').replace(/^﻿/, ''));
  const employees = new Map(Object.entries(json.employees || {}).map(([k, v]) => [normCode(k), Number(v)]));
  const designations = new Map(Object.entries(json.designations || {}).map(([k, v]) => [normDesig(k), Number(v)]));
  const designationNames = new Map(Object.keys(json.designations || {}).map((k) => [normDesig(k), k]));
  cache = { mtimeMs: stat.mtimeMs, generatedAt: json.generatedAt, employees, designations, designationNames };
  return cache;
}

/** Returns { ratio, source } where source is 'employee' | 'designation' | 'default'. */
function lookupRatio(ratios, codes, designation) {
  for (const [column, code] of codes) {
    const r = ratios.employees.get(normCode(code));
    if (code != null && normCode(code) && Number.isFinite(r)) {
      return { ratio: r, source: 'employee', matchedBy: column, matchedKey: String(code) };
    }
  }
  const d = ratios.designations.get(normDesig(designation));
  if (Number.isFinite(d)) {
    return { ratio: d, source: 'designation', matchedBy: 'Designation', matchedKey: ratios.designationNames.get(normDesig(designation)) };
  }
  return { ratio: 1, source: 'default', matchedBy: null, matchedKey: null };
}

/** Normalises a DB date (Date, 'YYYY-MM-DD...', 'DD-MM-YYYY', 'DD/MM/YYYY') to 'YYYY-MM-DD', or null. */
function toYMD(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) return null;
    return v.toISOString().slice(0, 10);
  }
  const s = String(v).trim();
  if (!s || /^0000-00-00/.test(s)) return null;
  let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  m = s.match(/^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})/);
  if (m) return `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return undefined; // present but unreadable
}

const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};

/** Splits `total` across components in proportion to their share of gross; Basic takes the rounding remainder. */
function splitByComponents(total, gross, parts) {
  const out = {};
  let used = 0;
  for (const k of ['HouseRent', 'Medical', 'Conveyance']) {
    out[k] = Math.round(total * (parts[k] / gross));
    used += out[k];
  }
  out.Basic = total - used;
  out.Total = total;
  return out;
}

/** Case-insensitive column accessor for a DB row. */
function rowReader(row) {
  const lower = {};
  for (const k of Object.keys(row)) lower[k.toLowerCase()] = row[k];
  return (name) => lower[name.toLowerCase()];
}

/**
 * Builds slip data for every row. Returns { slips, skipped, summary }.
 * `slips` holds everyone who passes the threshold (cash may still be 0 when ratio is 1.0).
 */
function buildCashSlips(rows, { cutoff = DEFAULT_CUTOFF } = {}) {
  const ratios = loadRatios();
  const slips = [];
  const skipped = { noGross: 0, belowThreshold: 0, separated: 0, badDOJ: 0, duplicate: 0 };
  const badRows = [];
  const duplicates = [];
  const seen = new Set();

  for (const row of rows) {
    const get = rowReader(row);
    const gross = Math.round(num(get('Gross')));
    const code = get('EmployeeCode');
    const ident = { code: String(code == null ? '' : code), name: get('EmployeeName') || '' };

    // One slip per employee per month; a second row for the same code is reported, not paid twice.
    if (seen.has(normCode(code))) { skipped.duplicate++; duplicates.push(ident.code); continue; }
    seen.add(normCode(code));

    // 1. Active check first: anyone with a DOS (any date) has left and is out.
    const dos = toYMD(get('DOS'));
    if (dos !== null) { skipped.separated++; continue; }

    if (gross <= 0) { skipped.noGross++; continue; }

    const doj = toYMD(get('DOJ'));
    if (!doj) { skipped.badDOJ++; badRows.push({ ...ident, DOJ: String(get('DOJ')) }); continue; }

    // 2. Actual gross = OrgGross x ratio; the threshold (by DOJ) applies to it.
    const lookup = lookupRatio(ratios, [['EmployeeCode', code], ['DisplayEmployeeCode', get('DisplayEmployeeCode')]], get('Designation'));
    const { ratio, source } = lookup;
    const actualExact = gross * ratio;
    const actual = Math.round(actualExact);

    const joinedBefore = doj < cutoff;
    const threshold = joinedBefore ? THRESHOLD_BEFORE : THRESHOLD_AFTER;
    if (actual < threshold) { skipped.belowThreshold++; continue; }

    const parts = {};
    for (const k of COMPONENTS) parts[k] = num(get(k));
    // Basic takes whatever the Org heads do not add up to, so the slip shows only four heads.
    const partsSum = COMPONENTS.reduce((s, k) => s + parts[k], 0);

    const bankTotal = gross;
    const cashTotal = actual - gross;

    slips.push({
      ...ident,
      displayCode: String(get('DisplayEmployeeCode') || ident.code),
      designation: get('Designation') || '',
      department: get('Department') || '',
      unit: get('Unit') || '',
      doj,
      gross,
      actual,
      threshold,
      ratio: Number(ratio.toFixed(6)),
      ratioSource: source,
      bank: splitByComponents(bankTotal, gross, parts),
      cash: splitByComponents(cashTotal, gross, parts),
      // Inputs and intermediate values behind the numbers above, for on-screen tracing only.
      trace: {
        cutoff,
        rawDOJ: get('DOJ') instanceof Date ? get('DOJ').toISOString().slice(0, 10) : String(get('DOJ') ?? ''),
        dos: dos || null,
        joinedBefore,
        lookup: {
          employeeCode: code == null ? null : String(code),
          displayCode: get('DisplayEmployeeCode') == null ? null : String(get('DisplayEmployeeCode')),
          designation: get('Designation') || '',
          matchedBy: lookup.matchedBy,
          matchedKey: lookup.matchedKey,
        },
        ratioExact: ratio,
        actualExact,
        salaryProcId: get('SalaryProcID') == null ? null : String(get('SalaryProcID')),
        parts,
        partsSum,
      },
    });
  }

  slips.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  const withCash = slips.filter((s) => s.cash.Total > 0);
  return {
    slips,
    skipped,
    badRows: badRows.slice(0, 20),
    duplicates: duplicates.slice(0, 20),
    summary: {
      cutoff,
      totalRows: rows.length,
      qualified: slips.length,
      withCash: withCash.length,
      totalCash: withCash.reduce((s, x) => s + x.cash.Total, 0),
      totalBank: slips.reduce((s, x) => s + x.bank.Total, 0),
      totalActual: slips.reduce((s, x) => s + x.actual, 0),
      bySource: slips.reduce((acc, s) => ((acc[s.ratioSource] = (acc[s.ratioSource] || 0) + 1), acc), {}),
      ratiosGeneratedAt: ratios.generatedAt,
    },
  };
}

module.exports = { buildCashSlips, loadRatios, DEFAULT_CUTOFF };
