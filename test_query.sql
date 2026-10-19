/* =============================================================================
   test_query.sql  -  Sample queries for the "Cash slips from a custom query" box
   =============================================================================

   HOW TO USE
   ----------
   1. The Query box runs ONE statement at a time. Copy ONE block below
      (from its SELECT / WITH down to the end of that block), paste it into the
      box, and click "Run query" (or press Ctrl+Enter).
   2. Comments (line comments and block comments) are fine; the app ignores them.
   3. Only SELECT is allowed. Anything that writes (UPDATE, DELETE, INSERT,
      EXEC, ...) is blocked before the app even connects.
   4. Syntax is SQL Server (T-SQL): use TOP instead of LIMIT, [ ] for names
      with spaces, and 'single quotes' for text.

   COLUMNS THE RESULT MUST HAVE (rename with AS if your names differ)
   -------------------------------------------------------------------
     EmployeeCode, EmployeeName, Designation,
     OrgGross, OrgBasic, OrgHouseRent, OrgMedical, OrgConvence,
     DOJ, DOS
   Optional: SalaryProcID (printed as "Salary ref." on the slip),
             DisplayEmployeeCode, Department, Unit

   BEFORE YOU START: replace these placeholders
   --------------------------------------------
     'YOUR_SALARY_PROC_ID'  ->  the SalaryProcID of the month you want
                                (query 0A below lists them)
     e.Designation          ->  your real designation column in
                                MonthWiseSalaryInfoExt (query 0B finds it)
     e.Department           ->  your real department column (only in query 2)

   The app applies the rules itself, in this order:
     1. anyone with a DOS is excluded (not active)
     2. actual gross = OrgGross x ratio
        DOJ before 1 Sep 2026   -> needs actual gross >= 60,000
        DOJ on/after 1 Sep 2026 -> needs actual gross >= 100,000
     3. bank = OrgGross, cash = actual gross - OrgGross
   So the queries below do NOT need to filter on DOS or salary themselves.
   ============================================================================= */


/* -----------------------------------------------------------------------------
   0A. HELPER - list the salary months (SalaryProcID)
   NOTE: run this in SSMS, not in the Query box. The Query box only accepts
   results that have the slip columns, so it would answer "missing column(s)".
   (The Cash slips panel's "Salary month" dropdown shows the same list.)
   ----------------------------------------------------------------------------- */
SELECT SalaryProcID, COUNT(*) AS Employees
FROM dbo.MonthWiseSalaryInfo
GROUP BY SalaryProcID
ORDER BY SalaryProcID DESC;


/* -----------------------------------------------------------------------------
   0B. HELPER - find the designation / department column names
   NOTE: run in SSMS (same reason as 0A). In the app you can also click the
   MonthWiseSalaryInfoExt table to see all of its columns.
   ----------------------------------------------------------------------------- */
SELECT COLUMN_NAME, DATA_TYPE
FROM INFORMATION_SCHEMA.COLUMNS
WHERE TABLE_NAME = 'MonthWiseSalaryInfoExt'
  AND (COLUMN_NAME LIKE '%Desig%' OR COLUMN_NAME LIKE '%Dep%' OR COLUMN_NAME LIKE '%Unit%')
ORDER BY ORDINAL_POSITION;


/* -----------------------------------------------------------------------------
   1. ALL EMPLOYEES FOR ONE MONTH  (start here)
   Same data as the Cash slips panel, but you control the query.
   ----------------------------------------------------------------------------- */
SELECT
    s.EmployeeCode,
    e.DisplayEmployeeCode,
    e.EmployeeName,
    e.Designation   AS Designation,      -- change to your designation column
    s.OrgGross,
    s.OrgBasic,
    s.OrgHouseRent,
    s.OrgMedical,
    s.OrgConvence,
    e.DOJ,
    e.DOS,
    s.SalaryProcID                       -- printed as "Salary ref." on the slip
FROM dbo.MonthWiseSalaryInfo AS s
JOIN dbo.MonthWiseSalaryInfoExt AS e
  ON e.EmployeeCode = s.EmployeeCode
 AND e.SalaryProcID = s.SalaryProcID     -- both keys, so each month joins to its own row
WHERE s.SalaryProcID = 'YOUR_SALARY_PROC_ID';


/* -----------------------------------------------------------------------------
   2. ONE DEPARTMENT ONLY
   Change the department column and value. LIKE '%...%' also matches partial names.
   ----------------------------------------------------------------------------- */
SELECT
    s.EmployeeCode, e.DisplayEmployeeCode, e.EmployeeName,
    e.Designation   AS Designation,
    e.Department    AS Department,       -- change to your department column
    s.OrgGross, s.OrgBasic, s.OrgHouseRent, s.OrgMedical, s.OrgConvence,
    e.DOJ, e.DOS, s.SalaryProcID
FROM dbo.MonthWiseSalaryInfo AS s
JOIN dbo.MonthWiseSalaryInfoExt AS e
  ON e.EmployeeCode = s.EmployeeCode AND e.SalaryProcID = s.SalaryProcID
WHERE s.SalaryProcID = 'YOUR_SALARY_PROC_ID'
  AND e.Department LIKE '%Finance%';     -- e.g. 'Finance & Accounts'


/* -----------------------------------------------------------------------------
   3. SPECIFIC EMPLOYEES  (when you only need a few slips)
   EmployeeCode is text (varchar), so keep the quotes and leading zeros.
   ----------------------------------------------------------------------------- */
SELECT
    s.EmployeeCode, e.DisplayEmployeeCode, e.EmployeeName,
    e.Designation   AS Designation,
    s.OrgGross, s.OrgBasic, s.OrgHouseRent, s.OrgMedical, s.OrgConvence,
    e.DOJ, e.DOS, s.SalaryProcID
FROM dbo.MonthWiseSalaryInfo AS s
JOIN dbo.MonthWiseSalaryInfoExt AS e
  ON e.EmployeeCode = s.EmployeeCode AND e.SalaryProcID = s.SalaryProcID
WHERE s.SalaryProcID = 'YOUR_SALARY_PROC_ID'
  AND s.EmployeeCode IN ('00012', '00021', '00043');


/* -----------------------------------------------------------------------------
   4. NEW JOINERS ONLY  (DOJ on or after 1 Sep 2026)
   These employees need an actual gross (OrgGross x ratio) >= 100,000 to get
   cash; the app checks that.
   ----------------------------------------------------------------------------- */
SELECT
    s.EmployeeCode, e.DisplayEmployeeCode, e.EmployeeName,
    e.Designation   AS Designation,
    s.OrgGross, s.OrgBasic, s.OrgHouseRent, s.OrgMedical, s.OrgConvence,
    e.DOJ, e.DOS, s.SalaryProcID
FROM dbo.MonthWiseSalaryInfo AS s
JOIN dbo.MonthWiseSalaryInfoExt AS e
  ON e.EmployeeCode = s.EmployeeCode AND e.SalaryProcID = s.SalaryProcID
WHERE s.SalaryProcID = 'YOUR_SALARY_PROC_ID'
  AND e.DOJ >= '2026-09-01';


/* -----------------------------------------------------------------------------
   5. TOP 50 BY ORGGROSS  (quick look at the highest salaries)
   TOP limits the rows; ORDER BY decides which ones.
   ----------------------------------------------------------------------------- */
SELECT TOP 50
    s.EmployeeCode, e.DisplayEmployeeCode, e.EmployeeName,
    e.Designation   AS Designation,
    s.OrgGross, s.OrgBasic, s.OrgHouseRent, s.OrgMedical, s.OrgConvence,
    e.DOJ, e.DOS, s.SalaryProcID
FROM dbo.MonthWiseSalaryInfo AS s
JOIN dbo.MonthWiseSalaryInfoExt AS e
  ON e.EmployeeCode = s.EmployeeCode AND e.SalaryProcID = s.SalaryProcID
WHERE s.SalaryProcID = 'YOUR_SALARY_PROC_ID'
ORDER BY s.OrgGross DESC;


/* -----------------------------------------------------------------------------
   6. CHECK THE CALCULATION ON ONE KNOWN EMPLOYEE
   For the July 2026 month, employee 00012 is expected to show OrgGross 60,360
   (the bank part, as orgGross_Jul2026 in the reference file). Click the row to
   open the trace: Actual gross should be 86,228 (60,360 x 1.428562),
   Bank 60,360 and Total Cash 25,868.
   If OrgGross shows 86,228 instead, OrgGross already holds the full gross and
   the cash would be counted twice - report it before printing any slips.
   ----------------------------------------------------------------------------- */
SELECT
    s.EmployeeCode, e.DisplayEmployeeCode, e.EmployeeName,
    e.Designation   AS Designation,
    s.OrgGross, s.OrgBasic, s.OrgHouseRent, s.OrgMedical, s.OrgConvence,
    e.DOJ, e.DOS, s.SalaryProcID
FROM dbo.MonthWiseSalaryInfo AS s
JOIN dbo.MonthWiseSalaryInfoExt AS e
  ON e.EmployeeCode = s.EmployeeCode AND e.SalaryProcID = s.SalaryProcID
WHERE s.SalaryProcID = 'YOUR_SALARY_PROC_ID'   -- the July 2026 SalaryProcID
  AND s.EmployeeCode = '00012';


/* -----------------------------------------------------------------------------
   7. COLUMNS WITH DIFFERENT NAMES  (rename with AS)
   Example when the designation column is called DesignationName and the name
   is split into first / last name. The app only cares about the names AFTER AS.
   ----------------------------------------------------------------------------- */
SELECT
    s.EmployeeCode,
    e.FName + ' ' + e.LName  AS EmployeeName,   -- build the name from two columns
    e.DesignationName        AS Designation,    -- rename to the required name
    s.OrgGross, s.OrgBasic, s.OrgHouseRent, s.OrgMedical, s.OrgConvence,
    e.DOJ, e.DOS, s.SalaryProcID
FROM dbo.MonthWiseSalaryInfo AS s
JOIN dbo.MonthWiseSalaryInfoExt AS e
  ON e.EmployeeCode = s.EmployeeCode AND e.SalaryProcID = s.SalaryProcID
WHERE s.SalaryProcID = 'YOUR_SALARY_PROC_ID';


/* -----------------------------------------------------------------------------
   8. TEST THE ERROR MESSAGES  (these SHOULD fail - try them once)
   8a. Typo in a column name -> yellow warning: Invalid column name 'OrgGros'.
   ----------------------------------------------------------------------------- */
SELECT s.EmployeeCode, s.OrgGros
FROM dbo.MonthWiseSalaryInfo AS s;

/* 8b. Missing slip columns -> "The query ran, but its result is missing column(s): ..." */
SELECT TOP 5 EmployeeCode, OrgGross
FROM dbo.MonthWiseSalaryInfo;

/* 8c. A write -> "Blocked by read-only mode" (blocked before connecting; nothing changes) */
UPDATE dbo.MonthWiseSalaryInfo SET OrgGross = 0 WHERE 1 = 0;
