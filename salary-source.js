'use strict';

/*
 * Cash slip data source: MonthWiseSalaryInfo (money) joined to MonthWiseSalaryInfoExt
 * (employee details) on EmployeeCode + SalaryProcID, for one SalaryProcID (salary month).
 *
 * The Org* columns are aliased to the names cash-slip.js works with, so OrgGross plays
 * the role "Gross" had before: bank = OrgGross / ratio, cash = OrgGross - bank.
 * Optional detail columns (Designation, Department, ...) are looked up by name at run
 * time, because their exact names differ between installations.
 */

const INFO = 'MonthWiseSalaryInfo';
const EXT = 'MonthWiseSalaryInfoExt';

// alias used by cash-slip.js -> column in MonthWiseSalaryInfo
const MONEY = {
  Gross: 'OrgGross',
  Basic: 'OrgBasic',
  HouseRent: 'OrgHouseRent',
  Medical: 'OrgMedical',
  Conveyance: 'OrgConvence',
};
const KEYS = ['EmployeeCode', 'SalaryProcID'];
const REQUIRED_INFO = [...KEYS, ...Object.values(MONEY)];
const REQUIRED_EXT = [...KEYS, 'DOJ'];

// alias -> accepted column names, searched in Ext first, then Info
const OPTIONAL = {
  DisplayEmployeeCode: ['DisplayEmployeeCode'],
  EmployeeName: ['EmployeeName'],
  Designation: ['Designation', 'DesignationName', 'Desig'],
  Department: ['Department', 'DepartmentName', 'Dept'],
  Unit: ['Unit', 'UnitName'],
  DOS: ['DOS'],
};

/**
 * Picks the two tables out of INFORMATION_SCHEMA rows ({schema, table, column}).
 * Returns { info: {schema, columns}, ext: {...} } with null for a missing table.
 * When a table exists in several schemas, dbo wins.
 */
function pickTables(rows) {
  const found = {};
  for (const name of [INFO, EXT]) {
    const bySchema = new Map();
    for (const r of rows) {
      if (String(r.table).toLowerCase() !== name.toLowerCase()) continue;
      if (!bySchema.has(r.schema)) bySchema.set(r.schema, []);
      bySchema.get(r.schema).push(r.column);
    }
    const schema = bySchema.has('dbo') ? 'dbo' : [...bySchema.keys()][0];
    found[name] = schema === undefined ? null : { schema, name, columns: bySchema.get(schema) };
  }
  return { info: found[INFO], ext: found[EXT] };
}

const findCol = (columns, wanted) => {
  const lower = new Map(columns.map((c) => [c.toLowerCase(), c]));
  for (const w of [].concat(wanted)) if (lower.has(w.toLowerCase())) return lower.get(w.toLowerCase());
  return null;
};

/**
 * Resolves every column the cash slip needs.
 * Returns { ready, missing: {info, ext}, warnings, map } where map holds
 * { alias: { from: 'info'|'ext', column } }.
 */
function resolveColumns(tables) {
  const missing = { info: [], ext: [] };
  const warnings = [];
  const map = {};
  if (!tables.info || !tables.ext) {
    return { ready: false, missing, warnings, map, tablesMissing: [!tables.info && INFO, !tables.ext && EXT].filter(Boolean) };
  }

  for (const k of KEYS) {
    const a = findCol(tables.info.columns, k);
    const b = findCol(tables.ext.columns, k);
    if (!a) missing.info.push(k);
    if (!b) missing.ext.push(k);
    map[`info.${k}`] = a;
    map[`ext.${k}`] = b;
  }
  for (const [alias, col] of Object.entries(MONEY)) {
    const c = findCol(tables.info.columns, col);
    if (!c) missing.info.push(col);
    map[alias] = { from: 'info', column: c };
  }
  const doj = findCol(tables.ext.columns, 'DOJ');
  if (!doj) missing.ext.push('DOJ');
  map.DOJ = { from: 'ext', column: doj };

  for (const [alias, names] of Object.entries(OPTIONAL)) {
    const e = findCol(tables.ext.columns, names);
    const i = e ? null : findCol(tables.info.columns, names);
    map[alias] = e ? { from: 'ext', column: e } : i ? { from: 'info', column: i } : null;
  }
  if (!map.Designation) warnings.push('No Designation column found: employees without their own ratio get 1.0 (no designation fallback).');
  if (!map.DOS) warnings.push('No DOS column found: separated employees cannot be excluded.');

  return { ready: !missing.info.length && !missing.ext.length, missing, warnings, map };
}

/**
 * Builds the read-only join for one SalaryProcID.
 * q(identifier) quotes a name for the engine; param is the placeholder ('@proc' or '?').
 */
function buildSlipQuery(tables, map, q, param) {
  const ref = (from, column) => `${from === 'info' ? 's' : 'e'}.${q(column)}`;
  const cols = [
    `${ref('info', map['info.EmployeeCode'])} AS ${q('EmployeeCode')}`,
    `${ref('info', map['info.SalaryProcID'])} AS ${q('SalaryProcID')}`,
  ];
  for (const alias of [...Object.keys(MONEY), 'DOJ', ...Object.keys(OPTIONAL)]) {
    const m = map[alias];
    if (m && m.column) cols.push(`${ref(m.from, m.column)} AS ${q(alias)}`);
  }
  return `SELECT ${cols.join(', ')}
  FROM ${q(tables.info.schema)}.${q(tables.info.name)} s
  JOIN ${q(tables.ext.schema)}.${q(tables.ext.name)} e
    ON e.${q(map['ext.EmployeeCode'])} = s.${q(map['info.EmployeeCode'])}
   AND e.${q(map['ext.SalaryProcID'])} = s.${q(map['info.SalaryProcID'])}
 WHERE s.${q(map['info.SalaryProcID'])} = ${param}`;
}

/** Lists the salary months (SalaryProcID) with their row counts, newest first. */
function buildProcListQuery(tables, map, q) {
  const col = `${q(map['info.SalaryProcID'])}`;
  return `SELECT ${col} AS ${q('id')}, COUNT(*) AS ${q('n')}
  FROM ${q(tables.info.schema)}.${q(tables.info.name)}
 GROUP BY ${col}
 ORDER BY ${col} DESC`;
}

module.exports = { INFO, EXT, MONEY, REQUIRED_INFO, REQUIRED_EXT, pickTables, resolveColumns, buildSlipQuery, buildProcListQuery };
