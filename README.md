# DB Explorer + Cash Slip

MySQL ba SQL Server-e connect kore database ar table browse kora jay. Payroll table theke protyek employee-r salary **bank part** ar **cash part**-e bhag kore cash slip print kora jay.

> **Confidential:** `docs/` (reference Excel) ar `data/` (ratio JSON) folder-e cash ratio thake. Duto folder-i `.gitignore`-e ache. Kokhono commit, email ba share korben na.

---

## Read-only: system shudhu data pore

Ei app database-e **kichu lekhe na, bodlay na, delete kore na**. Bhul kore-o jate na hoy, tai 3 ta lock ache:

| Lock | Ki kore |
|---|---|
| **SQL guard** | Server-e pathanor age protyekta query check hoy. Shudhu ekta `SELECT` ba `SHOW` jete pare. `INSERT`, `UPDATE`, `DELETE`, `DROP`, `TRUNCATE`, `SELECT ... INTO`, `FOR UPDATE` ba ek-er beshi statement pathanor age-i atke jay. |
| **DB session READ ONLY** | MySQL-e connect korei `SET SESSION TRANSACTION READ ONLY` chalano hoy. Code-e bhul thakleo MySQL server nije write refuse korbe. SQL Server-e shob query ekta transaction-er bhitore chole, ar sesh-e sob shomoy rollback hoy, kokhono commit hoy na. |
| **HTTP lock** | Browser theke shudhu `GET` (page) ar 4 ta read endpoint-e `POST` cholbe. Onno shob `POST`, `PUT`, `DELETE`, `PATCH` 405 diye bondho. |

> **Read endpoint POST keno?** `/api/connect`, `/api/tables`, `/api/columns`, `/api/cash-slips` DB-r username ar password request-er body-te niye jay. GET hole password URL-e boshto, ar URL browser history ar server log-e theke jay. Ei 4 ta endpoint shudhu DB theke pore, kichu save kore na.

**Aro nirapod korte:** DBA-ke diye ekta **SELECT-only user** baniye nin, ar shei user diye connect korun. Tahole app-er code bodlaleo kichu lekha jabe na:
```sql
CREATE USER 'payroll_reader'@'%' IDENTIFIED BY '...';
GRANT SELECT ON payroll_db.* TO 'payroll_reader'@'%';
```

**Error gulo warning:** data anar shomoy kono shomossa hole (connection, login, bhul table, ratio file nei, read-only block) holud **⚠ Warning** box-e dekhay. Server console-eo `[warning]` hishebe log hoy. Kichu lekha hoy na bole failed read-e DB-r kono khoti hoy na.

---

## 1. Prothombar setup (ekbar-i korte hobe)

**Dorkar:** Node.js 18 ba tar beshi version, ar Windows PowerShell.

1. Package install korun:
   ```bash
   npm install
   ```
2. Reference Excel-ta `docs/EmployeeCashRatio_Reference.xlsx` path-e rakhun.
3. Excel theke ratio file banan:
   ```bash
   powershell -ExecutionPolicy Bypass -File scripts/build-cash-ratios.ps1
   ```
   Thik moto chole gele erokom message ashbe: `Wrote 383 employee ratios and 20 designation ratios to ...data\cash_ratios.json`.
   Ei file-e shudhu EmployeeCode, Designation ar ratio thake. Name ba salary thake na.

> Reference Excel update hole step 3 abar chalaben. Server restart korte hobe na, notun file nije theke load hoye jay.

---

## 2. App chalano

```bash
npm start
```

Browser-e kholun: http://localhost:3000

---

## 3. Cash slip banano: puro flow

### Step 1: Connect
Bam dike **Connection** form-e eigulo din:
- **Database engine:** MySQL
- **Host / IP**, **Port** (MySQL-er default 3306), **Username**, **Password**
- **Database name:** jana thakle likhun, sorasori table-er list ashbe. Na jana thakle khali rakhun, shob database-er list ashbe.

Tarpor **Connect** chapun.

### Step 2: Database select
**Databases** list theke payroll-er database-e click korun. Daan dike tar table-er list ashbe.

### Step 3: Payroll table khuje ber kora
Table-er naam jana na thakleo cholbe:
- Kono table-e click korun. **Table details**-e column-er list ar row count dekhabe.
- Payroll table chenar upay: tate `EmployeeCode`, `Designation`, `Gross`, `DOJ` column thakbe (`docs/database_scema.xlsx` dekhun). Row count prai employee shonkhar soman hobe.
- Bhul table-e click korleo kono khoti nei. App shudhu pore, kichu lekhe na. Calculate chaple bole debe kon column nei.

### Step 4: Cash part calculate
Table select korle niche **Cash slips** panel ashbe.
1. **Cut-off date:** default `2026-09-01`. Onno mash-er jonno bodlate paren.
2. **Calculate cash part** chapun.

Hishab hoye gele upore summary dekhabe:
| Box | Mane |
|---|---|
| rows read | table-e mot koto row |
| pass threshold | koto jon salary-r shorto puron korche |
| with cash | koto jon-er cash > 0 |
| total cash / total bank | mot koto taka |

Status line-e dekhabe kar ratio kotha theke esheche, ar ke keno baad porlo. Niche **"Ratio status-e ki dekhben"** section-ta poren.

### Step 5: Check kora
Table-e protyek employee-r Gross, Ratio, Source, Bank, Cash ar Net bank dekhabe.
- **Only employees with cash > 0:** tick thakle shudhu jader cash ache tara dekhabe. Tick tule dile ratio 1.0-er lok-o dekhabe.
- **Calculation trace:** kono row-e click korle niche oi employee-r puro hishab step by step khulbe. Ei trace shudhu screen-e dekha jay, print-e ashe na.
  1. **Cash pabe kina:** DOJ, cut-off, threshold, Gross, DOS.
  2. **Ratio khoja:** EmployeeCode, DisplayEmployeeCode ar Designation, kon-ta try hoyeche ar kon-ta mileche. Exact ratio-o dekhay.
  3. **Bank ar cash:** `Gross ÷ Ratio`-er round korar ager value, round-er por value, ar cash.
  4. **Vag onujayi breakdown:** protyek vag-er %, bank, cash, kivabe hishab holo, ar Basic-e round-er baki koto boshlo.
  5. **Deduction:** kon column-e koto. `TotalDeductionsListed`-er sathe column gulor jogfol na mille ⚠ dekhabe.
  6. **Check:** Bank + Cash = Gross kina, ar employee hate mot koto pabe.

### Step 6: Output
- **Download CSV:** puro breakdown ashbe (bank ar cash duto-i, ratio soho). Excel-e khule check korun. Ei file **internal**, kauke deben na.
- **Print slips:** notun window-e slip khulbe ar print dialog ashbe. Protyek slip-e shudhu **cash part** thake. Ratio ba bank-er hishab slip-e thake na. PDF chaile print dialog-e "Save as PDF" select korun.

> Pop-up block thakle Print kaj korbe na. Browser-e `localhost:3000`-er jonno pop-up allow korun.

---

## 4. Hishab-er rule

### Ke cash pabe (cut-off = 1 Sep 2026)
| Shorto | Cash pabe jodi |
|---|---|
| DOJ cut-off-er **age** | Gross ≥ **60,000** |
| DOJ cut-off-er **dine ba pore** | Gross ≥ **100,000** |
| Gross 0 ba khali | baad |
| DOS cut-off-er age (chole geche) | baad |
| DOJ pora jacche na | baad (status-e code dekhabe) |

DOJ ei format gulo pora jay: `YYYY-MM-DD`, `DD-MM-YYYY`, `DD/MM/YYYY`.

### Ratio kotha theke ashe (ei order-e khuje)
1. **Employee:** `EmployeeCode` diye khuje, na mille `DisplayEmployeeCode` diye. Leading zero bad diye mile, tai `12` ar `00012` eki dhora hoy.
2. **Designation:** employee-r nijer ratio na thakle designation-er average. Choto-boro haat, dot ar space-er parthokko dhore na, tai `Sr. Manager` ar `sr manager` eki.
3. **Default 1.0:** kono-tai na mille ratio 1.0, mane cash 0.

### Bank ar cash bhag
```
Gross   = actual gross (bank + cash)
Bank    = round(Gross / ratio)
Cash    = Gross - Bank
```
Bank ar cash, duto-i Basic, House rent, Medical, Conveyance ar Other allowances-e bhag hoy. Gross-e protyek vag-er je onupat, sei onupatei bhag hoy. Round korar por ja baki thake, Basic-e jog hoy, tai jog kore total thik mile.

### Deduction
- `TotalDeductionsListed` column thakle seta use hoy. Na thakle eigulo jog kora hoy: LunchDeduction, ExtraMobileBill, IncomeTax, PF, Stamp, FairShop, Advance, VehicleDeduction, OtherDeduction.
- Deduction shudhu **bank part** theke kate: `Net bank = Bank − Deduction`. Cash part-e kono deduction nei.

---

## 5. Ratio status-e ki dekhben

Calculate korar por status line ek bar poren:
- **default 1.0** onek beshi hole: employee code ba designation-er banan reference file-er sathe milche na. CSV-te `RatioSource = default` row gulo dekhun.
- **designation** beshi hole: notun join kora lok ba reference-er scope-er baire-r lok (reference-e shudhu Corporate MS staff ache). Eta swabhabik, tobu ek bar check kore niben.
- **unreadable DOJ:** oi employee-der DOJ DB-te thik korte hobe, noile tara baad thakbe.

---

## 6. Somossa hole

| Message | Ki korben |
|---|---|
| `Cash ratio file data/cash_ratios.json is missing` | Section 1-er step 3 chalan |
| `Table "..." is missing column(s) ...` | Bhul table. Onno table select korun |
| `Authentication failed` | Username ba password bhul |
| `Connection refused` / `timed out` | Host, port ba firewall check korun |
| Print window khule na | Browser-e pop-up allow korun |

---

## 7. File gulo

| File | Kaj |
|---|---|
| `server.js` | Express server. API: `/api/connect`, `/api/tables`, `/api/columns`, `/api/cash-slips` |
| `cash-slip.js` | Eligibility, ratio lookup ar bank/cash bhag-er hishab |
| `public/index.html` | UI: connection, table browse, Cash slips panel, CSV, print |
| `scripts/build-cash-ratios.ps1` | Reference Excel theke `data/cash_ratios.json` banay |
| `docs/` | Reference Excel ar schema (confidential, git-ignored) |
| `data/` | Ratio JSON (confidential, git-ignored) |
