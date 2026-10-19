# DB Explorer + Cash Slip

Connect to MySQL or SQL Server and browse databases and tables. From the payroll data, split each employee's salary into a **bank part** and a **cash part**, then print cash slips.

> **Confidential:** the `docs/` (reference Excel) and `data/` (ratio JSON) folders hold the cash ratios. Both are in `.gitignore`. Never commit, email or share them.

---

## Read-only: the system only reads data

This app **never writes, changes or deletes** anything in the database. Three locks make sure that cannot happen even by mistake:

| Lock | What it does |
|---|---|
| **SQL guard** | Every query is checked before it is sent to the server, including queries typed in the Query box. Only a single `SELECT` (or `WITH ... SELECT`) is allowed. Comments (`--`, `/* */`) and text inside strings are handled separately. A query is blocked if `INSERT`, `UPDATE`, `DELETE`, `MERGE`, `DROP`, `ALTER`, `CREATE`, `TRUNCATE`, `EXEC`, `DECLARE`, `SET`, `OPENROWSET`, `SELECT ... INTO`, `FOR UPDATE` or more than one statement appears anywhere in it. |
| **DB session READ ONLY** | On MySQL, `SET SESSION TRANSACTION READ ONLY` runs right after connecting, so the server itself refuses any write even if the code has a bug. On SQL Server, every query runs inside a transaction that is always rolled back, never committed. |
| **HTTP lock** | The browser may only use `GET` (the page), `POST` on the 8 read endpoints, and `POST` on the 5 local settings endpoints (saved connection, saved queries). Every other `POST`, and all `PUT`, `DELETE` and `PATCH` requests, get 405. Those only write to local files in `data/` (`connection.json`, `saved-queries.json`), never to the database. |

> **Why do the read endpoints use POST?** `/api/connect`, `/api/tables`, `/api/columns`, `/api/salary-source`, `/api/cash-slips`, `/api/query-slips`, `/api/distinct-values` and `/api/run-query` carry the DB username and password in the request body. With GET, the password would sit in the URL, which ends up in browser history and server logs. These 8 endpoints only read from the database and save nothing.

**For extra safety:** ask your DBA to create a **SELECT-only user** and connect with it. Then nothing can be written even if the app code changes:

SQL Server (your salary DB):
```sql
CREATE LOGIN payroll_reader WITH PASSWORD = '...';
USE YourSalaryDb;
CREATE USER payroll_reader FOR LOGIN payroll_reader;
ALTER ROLE db_datareader ADD MEMBER payroll_reader;
```
MySQL:
```sql
CREATE USER 'payroll_reader'@'%' IDENTIFIED BY '...';
GRANT SELECT ON payroll_db.* TO 'payroll_reader'@'%';
```

**Errors are shown as warnings:** any problem while fetching data (connection, login, wrong table, missing ratio file, read-only block) appears in a yellow **⚠ Warning** box and is logged as `[warning]` in the server console. Because nothing is written, a failed read cannot harm the database.

---

## 1. First-time setup (once)

**Requirements:** Node.js 18 or later, and Windows PowerShell.

1. Install the packages:
   ```bash
   npm install
   ```
2. Put the reference Excel at `docs/EmployeeCashRatio_Reference.xlsx`.
3. Build the ratio file from the Excel:
   ```bash
   powershell -ExecutionPolicy Bypass -File scripts/build-cash-ratios.ps1
   ```
   On success you will see a message like `Wrote 383 employee ratios and 20 designation ratios to ...data\cash_ratios.json`.
   This file holds only EmployeeCode, Designation and ratio. No names or salaries.

> Run step 3 again whenever the reference Excel is updated. No server restart is needed; the new file is loaded automatically.

---

## 2. Run the app

```bash
npm start
```

Open http://localhost:3000 in your browser.

### The layout
The left **sidebar** has five tabs. On a phone or narrow window the sidebar is hidden; tap the **☰** button at the top to open it.

| Tab | What it is for |
|---|---|
| **Database connection** | Connect, save the connection, browse databases, tables and columns. |
| **Overview** | Placeholder: graphical visualization of your data is planned for a future version. |
| **SQL query** | Run any read-only `SELECT` and see the result table, or the exact error the database returns. |
| **Payroll** | Cash slips, with three sub-tabs: **Auto (MonthWise tables)**, **Manual mapping**, **Custom query**. |
| **User separation** | Placeholder for a future module. The buttons are shown but do nothing yet. |

The bottom of the sidebar always shows what you are connected to (`user@host:port / database`). The SQL query and Payroll tabs need a selected database; until then they show a link back to Database connection. The app remembers the last tab and Payroll sub-tab you used.

### SQL query tab
1. Select a database first (Database connection tab).
2. Type or paste a query, e.g. `SELECT TOP 100 * FROM dbo.MonthWiseSalaryInfo`, then click **Run query** or press `Ctrl+Enter`.
3. **Success:** the result appears as a table with the row count and how long it took. Up to 1,000 rows are shown; `NULL` values are shown in grey. **Download CSV** exports the result.
4. **Error:** a yellow ⚠ warning shows the database's own message, e.g. `Invalid column name 'OrgGros'` or `Invalid object name 'dbo.Salary'`. Anything that writes (`UPDATE`, `DELETE`, `INSERT`, `EXEC`, …) is blocked before the app connects.
5. **Use in Payroll → Custom query** copies the query into the Payroll tab's Custom query box, so you can test a query here first and then make slips from it.

The app remembers the last query per database.

#### Saved queries (for queries you run often)
The **Saved queries** table on the left of the SQL query tab keeps named queries.

- **Save:** type a name in the box above the editor and click **Save** (or press `Ctrl+S`). Names are unique (ignoring upper/lower case).
- **Load:** click a name in the table. The query fills the editor; edit it, or run it as it is. The result shows below in a table.
- **▶** next to a name loads **and runs** it in one click.
- **Update:** after loading a query, change it and click **Save** again. The editor shows **Unsaved changes** until you do.
- **Save as new:** keeps the original and saves your edited copy under a new name.
- **New:** clears the editor to start a fresh query.
- **Delete:** removes the saved query (you are asked first). The editor keeps its text.
- **Search** filters by name or by text inside the query.

Only `SELECT` queries can be saved, the same rule as running them. Saved queries are kept on this PC only, in `data/saved-queries.json` (git-ignored), so they survive browser resets. They are not shared with other PCs: copy that file if you need them elsewhere.

---

## 3. Making cash slips: the full flow

### Step 1: Connect
Fill in the **Connection** form on the left:
- **Database engine:** **SQL Server (MSSQL)**. The salary tables are on SQL Server (`dbo` schema).
- **Host / IP**, **Port** (SQL Server default is 1433), **Username**, **Password**
- **Database name:** if you know it, type it and the table list loads directly. Otherwise leave it empty to list all databases.

The first time, tick **Save this connection**, then click **Connect**.

#### Saved connection and auto-connect
- With the box ticked, the connection is saved only when the connect **succeeds**, so a wrong password is never saved.
- From then on, after `npm start`, opening the page will:
  1. fill in the form,
  2. connect,
  3. reopen the database and table you had open last time. The Cash slips panel also remembers the last salary month you chose.

  You only need to click **Calculate cash part**.
- **Where it is saved:** only on this PC, in `data/connection.json` (git-ignored). The password is encrypted with **Windows DPAPI**: only your Windows user on this PC can decrypt it. Copying the file to another PC will not work.
- The password is never sent back to the browser. The password box shows `•••••• saved (encrypted)`, and the server fills in the saved password itself when auto-connecting.
- **If the password changes:** auto-connect shows a ⚠ Authentication warning. Type the new password and click Connect; the new one is saved.
- **To use another server:** change the host, user or password. The saved connection is then not used and the new details are used instead. If the box is ticked, the new connection is saved.
- **To remove it:** click **Forget saved connection**, or untick the box and connect.

### Step 2: Select the database
Click the salary database in the **Databases** list. Its tables appear on the right.

If the database has both `MonthWiseSalaryInfo` and `MonthWiseSalaryInfoExt`, open the **Payroll** tab: the **Auto (MonthWise tables)** sub-tab shows the **Cash slips — MonthWiseSalaryInfo + Ext** panel. You do not need to click a table. If either table is missing, the panel shows a yellow ⚠ warning.

> Clicking a table only shows its columns and row count (Table details). It has no effect on the cash slip calculation.

### Step 3: Choose the month and calculate
1. **Salary month (SalaryProcID):** the dropdown lists the months found in the database with their row counts, newest first. Pick the month you need slips for. The app remembers your choice.
2. **Cut-off date:** defaults to `2026-09-01`. It decides who falls under the 60k rule and who falls under the 100k rule.
3. Click **Calculate cash part**.

The app joins the two tables on `EmployeeCode` + `SalaryProcID` and fetches only the rows for the selected month:
- **From `MonthWiseSalaryInfo`:** `OrgGross`, `OrgBasic`, `OrgHouseRent`, `OrgMedical`, `OrgConvence`.
- **From `MonthWiseSalaryInfoExt`:** `DisplayEmployeeCode`, `EmployeeName`, `DOJ`, `DOS`, and Designation/Department/Unit if present.

The designation column is found automatically if it is named `Designation`, `DesignationName` or `Desig`. If none is found you get a warning, and the designation fallback is turned off.

When the calculation finishes, a summary appears at the top:
| Box | Meaning |
|---|---|
| rows read | total rows for that month |
| pass threshold | how many meet the actual gross condition |
| with cash | how many have cash > 0 |
| total cash / total bank | total amounts |

The status line shows where each ratio came from and why people were excluded. If an employee has two rows in the same month, only the first is used and the code is listed in the warning. See **"Reading the ratio status"** below.

### Step 4: Check the results
The table shows each employee's OrgGross, Ratio, Source, Actual gross, Bank and Cash.
- **Only employees with cash > 0:** when ticked, only employees with cash are shown. Untick it to also see employees with ratio 1.0.
- **Calculation trace:** click any row to open that employee's full calculation, step by step. The trace is shown on screen only and never printed.
  1. **Eligibility:** DOS, DOJ, cut-off, threshold, and the actual gross it is compared with.
  2. **Ratio lookup:** which of EmployeeCode, DisplayEmployeeCode and Designation was tried and which matched, plus the exact ratio.
  3. **Bank / cash split:** Bank = OrgGross; Actual = `OrgGross × Ratio` before and after rounding; Cash = Actual − OrgGross.
  4. **Breakdown by component:** the % of OrgBasic/OrgHouseRent/OrgMedical/OrgConvence, bank, cash, how each was calculated, and the remainder added to Basic. A ⚠ appears if the Org components do not add up to OrgGross.
  5. **Check:** whether Bank + Cash = Actual gross, and the 4 amounts that go on the slip.

### Step 5: Output
- **Download CSV:** the full breakdown (SalaryProcID, both bank and cash, with ratio). Open it in Excel to check. This file is **internal**; do not give it to anyone.
- **Print slips:** opens the slips in a new window with the print dialog. Each slip shows:
  - the employee's details and Salary ref. (SalaryProcID),
  - **Cash Basic, Cash House Rent, Cash Medical, Cash Conveyance** and **Gross Cash**.

  The ratio and the bank part are not on the slip. For a PDF, choose "Save as PDF" in the print dialog.

> Printing does not work if pop-ups are blocked. Allow pop-ups for `localhost:3000` in your browser.

### Cash slips by manual mapping (no SQL needed)
Use this when your table or column names differ from the defaults, or when a field such as Designation lives in another table. Open **Payroll → Manual mapping**.

1. **Tables:** pick the **Salary table** and the **Employee table**. If `MonthWiseSalaryInfo` and `MonthWiseSalaryInfoExt` exist, they are selected already.
2. **Keys:** the **Employee key** (e.g. `EmployeeCode = EmployeeCode`) and the **Month key** (e.g. `SalaryProcID = SalaryProcID`) are filled in when the names match. If the employee table has no month column, choose "(employee table has no month column)".
3. **Fields:** the panel lists everything the calculation needs: **9 required fields** (marked `*`), plus DOS (recommended, to exclude inactive employees), Display code and Department (optional). For each field, pick the table (`s` salary, `e` employee, `x1`… added tables) and the column. Columns with matching names are picked automatically. A field that still needs a column is highlighted yellow and marked **needs a column**, and Run stays blocked until every required field is set.
4. **+ Add table** (up to 3): when a field is in another table, for example Designation in a designation master table, add that table and set how it joins, e.g. `Employee table . DesignationID = DesignationID`. A shared column (preferably one ending in `ID`) is suggested automatically. Then set the field's table to `x1` and pick its column (e.g. `DesignationName`). Added tables use a LEFT JOIN, so employees are never dropped when a match is missing.
5. **Salary month:** the list of values from the salary table's month column, newest first, with row counts.
6. Click **Run**. The results table works exactly like the custom query's: checkboxes, calculation trace, **Download selected slips** and **Download selected CSV**.
7. **Show SQL** shows the SELECT the app built. **Copy into the custom query box** puts it in the query panel, so you can adjust it or save it.

The mapping is remembered per database. With a saved connection, everything is filled in again when you open the page; you only check the month and click **Run**. The app never runs it automatically, so you always confirm the month first.

### Cash slips from a custom query
Open **Payroll → Custom query**. Use it to run your own SELECT query and make slips from the result, for example for one department, a few employees, or a different table.

1. **Write the query.** The box starts with a **template**. Replace the placeholder names (`dbo.SalaryTableName`, `dbo.EmployeeTableName`, `'YOUR_SALARY_PROC_ID'`) with your own, or paste your own query. **Reset to template** brings the template back. The app remembers your last query.
2. **Use SQL Server syntax** (`TOP`, `[ ]`). The result must contain these column names; rename with `AS` if needed:
   `EmployeeCode, EmployeeName, Designation, OrgGross, OrgBasic, OrgHouseRent, OrgMedical, OrgConvence, DOJ, DOS`.
   If you include `SalaryProcID`, it appears on the slip as "Salary ref.".
3. Click **Run query**, or press `Ctrl+Enter`.
4. **Errors** are shown as a yellow ⚠ warning:
   - SQL mistakes show SQL Server's own message, e.g. `Invalid column name 'OrgGros'`.
   - Any attempt to write shows "Blocked by read-only mode …". This is blocked before the app even connects to the database.
   - Missing required columns show "missing column(s): …".
   - More than 5,000 rows asks you to narrow the query with `WHERE`.
5. **On success** the table shows only **eligible** employees. Order: anyone with a DOS is excluded, then actual gross (OrgGross × ratio) ≥ 60k/100k depending on DOJ. Columns: Employee ID, Name, Designation, OrgGross, Actual Gross, Cash Basic, Cash House Rent, Cash Medical, Cash Conveyance, Total Cash. The status line counts who was excluded and why.
6. **Checkboxes:** tick the employees whose slips you need, or use the header checkbox to select everyone. A count such as "2 selected of 5" is shown. Employees with ratio 1.0 have no cash, so their checkbox is disabled.
7. **Download selected slips:** opens only the ticked employees' slips in a print window. "Save as PDF" gives one PDF with all of them. **Download selected CSV** exports the same employees to an Excel file.
8. Clicking a row opens the **calculation trace**, as above.

---

## 4. Calculation rules

### Who gets cash (checked in this order, cut-off = 1 Sep 2026)
| # | Condition | Result |
|---|---|---|
| 1 | **Has a DOS** (any date) | not active, **excluded first** |
| 2 | OrgGross is 0 or empty | excluded |
| 2 | DOJ cannot be read | excluded (code shown in the status) |
| 2 | DOJ **before** the cut-off | kept if **actual gross** ≥ **60,000** |
| 2 | DOJ **on or after** the cut-off | kept if **actual gross** ≥ **1,00,000** |
| 3 | Everyone left | bank = OrgGross, cash = actual gross − OrgGross |

**Actual gross = OrgGross × ratio.** The threshold is on the actual gross, not on OrgGross. The July 2026 reference data confirms this: every employee with an actual gross of 60,000 or more has a ratio above 1, and everyone below 60,000 has ratio 1 (for example OrgGross 53,000 → actual 75,091 gets cash).

An empty DOS (`NULL`, blank or `0000-00-00`) counts as active.

DOJ comes from SQL Server's `datetime`. Text dates in these formats are also read: `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY`.

### Where the ratio comes from (searched in this order)
1. **Employee:** by `EmployeeCode`, then by `DisplayEmployeeCode`. Leading zeros are ignored, so `12` and `00012` match.
2. **Designation:** if the employee has no ratio of their own, the designation average is used. Case, dots and extra spaces are ignored, so `Sr. Manager` and `sr manager` match.
3. **Default 1.0:** if nothing matches, the ratio is 1.0, which means no cash.

### Bank / cash split
**Step 1: bank part and actual gross**
```
Bank (OrgGross) = OrgGross                     (from the database)
Actual gross    = round(OrgGross × Ratio)      (Ratio: employee → designation → 1.0)
Cash            = Actual gross − OrgGross
```
**Step 2: component shares**, read for each employee from the database:
```
Basic %      = OrgBasic     / OrgGross
HouseRent %  = OrgHouseRent / OrgGross
Medical %    = OrgMedical   / OrgGross
Conveyance % = OrgConvence  / OrgGross
```
**Step 3: split the cash**
```
Cash House Rent = Cash × HouseRent %
Cash Medical    = Cash × Medical %
Cash Conveyance = Cash × Conveyance %
Cash Basic      = Cash − (House Rent + Medical + Conveyance)   ← rounding remainder goes here
Total Cash      = Cash
```
- The percentages are never fixed: each employee's own OrgBasic / OrgHouseRent / OrgMedical / OrgConvence decide them.
- Any gap between the Org components and OrgGross also goes to Basic, so the 4 components always add up to Total Cash.
- The bank part is split the same way (it equals the Org components when they add up to OrgGross).

**Example** (OrgGross 1,00,000; in the database OrgBasic 60,000, OrgHouseRent 30,000, OrgMedical 6,000, OrgConvence 4,000; ratio 1.428571):
```
Bank (OrgGross) = 1,00,000
Actual gross    = 1,00,000 × 1.428571 = 1,42,857
Cash            = 1,42,857 − 1,00,000 = 42,857
```

| | % (from DB) | Bank | Cash | Actual |
|---|---:|---:|---:|---:|
| Basic | 60% | 60,000 | 25,715 | 85,715 |
| House Rent | 30% | 30,000 | 12,857 | 42,857 |
| Medical | 6% | 6,000 | 2,571 | 8,571 |
| Conveyance | 4% | 4,000 | 1,714 | 5,714 |
| **Total** | **100%** | **1,00,000** | **42,857** | **1,42,857** |

Check against the reference file: employee 00012 has OrgGross 60,360 and ratio 1.428562, so actual = 86,228 and cash = 25,868, exactly as in `ActualGross_Jul2026`.

---

## 5. Reading the ratio status

After calculating, read the status line once:
- **Many "default 1.0":** employee codes or designation spellings do not match the reference file. Check the rows with `RatioSource = default` in the CSV.
- **Many "designation":** new joiners, or people outside the reference scope (the reference covers only Corporate MS staff). This is expected, but worth a quick check.
- **unreadable DOJ:** fix those employees' DOJ in the database, otherwise they stay excluded.
- **duplicate rows:** an employee has two rows in the same month. Only the first was used. Check the database.

---

## 6. Troubleshooting

| Message | What to do |
|---|---|
| `Cash ratio file data/cash_ratios.json is missing` | Run step 3 of section 1 |
| `This database has no MonthWiseSalaryInfo + MonthWiseSalaryInfoExt` | Wrong database. Select the salary database |
| `Required columns are missing` | The warning lists which column is missing from which table |
| `No Designation column found` | Designation fallback is off. Employees without their own ratio get no cash |
| `No rows for SalaryProcID ...` | No matching data for that month in the two tables. Pick another month |
| Mapping: `Required field(s) still need a column: ...` | Pick a column for the yellow fields. If the data is in another table, use **+ Add table** |
| Mapping: `An added table is missing its table or join columns` | Finish the added table row (table and both join columns), or remove it |
| `Invalid column name ...` / `Invalid object name ...` in the Query box | A placeholder column or table name in the template was not replaced, or is misspelled |
| `missing column(s): ...` in the Query box | The query ran, but the result lacks that name. Rename with `AS` |
| `more than 5,000 rows` in the Query box | Narrow it with `WHERE`, e.g. one SalaryProcID or department |
| `Authentication failed` | Wrong username or password |
| `Connection refused` / `timed out` | Check the host, port or firewall |
| Print window does not open | Allow pop-ups in your browser |
| `Authentication failed` on auto-connect | The saved password changed. Type the new password and click Connect |
| `Could not save the connection: DPAPI failed` | PowerShell is blocked. Contact IT, or connect without saving |

---

## 7. Files

| File | Purpose |
|---|---|
| `server.js` | Express server. API: `/api/connect`, `/api/tables`, `/api/columns`, `/api/salary-source`, `/api/cash-slips`, `/api/query-slips`, `/api/distinct-values`, `/api/run-query`. Contains the read-only guard |
| `salary-source.js` | Finds MonthWiseSalaryInfo + Ext, matches columns, builds the join query and the month list |
| `cash-slip.js` | Eligibility, ratio lookup and the bank/cash split |
| `public/index.html` | UI: sidebar with Database connection, SQL query, Payroll (auto / manual mapping / custom query) and User separation tabs; CSV and print |
| `saved-connection.js` | Saved connection, DPAPI encrypt/decrypt, remembers the last opened table |
| `saved-queries.js` | Named queries for the SQL query tab, stored in `data/saved-queries.json` |
| `scripts/build-cash-ratios.ps1` | Builds `data/cash_ratios.json` from the reference Excel |
| `docs/` | Reference Excel and table screenshots (confidential, git-ignored) |
| `data/` | Ratio JSON, `connection.json` (saved connection, encrypted password) and `saved-queries.json`. Confidential, git-ignored |
