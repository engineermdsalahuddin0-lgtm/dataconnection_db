# Builds data/cash_ratios.json from the confidential EmployeeCashRatio reference workbook.
# Only codes, designations and ratios are copied out; names and salaries stay in the Excel file.
# Re-run whenever the reference workbook is updated:
#   powershell -ExecutionPolicy Bypass -File scripts\build-cash-ratios.ps1

param(
  [string]$Source = (Join-Path $PSScriptRoot '..\docs\EmployeeCashRatio_Reference.xlsx'),
  [string]$Out = (Join-Path $PSScriptRoot '..\data\cash_ratios.json')
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.IO.Compression.FileSystem

$zip = [System.IO.Compression.ZipFile]::OpenRead((Resolve-Path $Source))
try {
  function Read-Entry($name) {
    $entry = $zip.GetEntry($name)
    if (-not $entry) { throw "Workbook has no $name" }
    $reader = New-Object System.IO.StreamReader($entry.Open())
    try { [xml]$reader.ReadToEnd() } finally { $reader.Close() }
  }

  $strings = @((Read-Entry 'xl/sharedStrings.xml').sst.si | ForEach-Object { $_.InnerText })

  # Map sheet name -> worksheet part, so the script does not depend on sheet order.
  $wb = Read-Entry 'xl/workbook.xml'
  $rels = Read-Entry 'xl/_rels/workbook.xml.rels'
  function Read-Sheet($sheetName) {
    $sheet = $wb.workbook.sheets.sheet | Where-Object { $_.name -eq $sheetName }
    if (-not $sheet) { throw "Workbook has no '$sheetName' sheet" }
    $rid = $sheet.GetAttribute('id', 'http://schemas.openxmlformats.org/officeDocument/2006/relationships')
    $target = ($rels.Relationships.Relationship | Where-Object { $_.Id -eq $rid }).Target -replace '^/?xl/', ''
    $xml = Read-Entry "xl/$target"

    $rows = @($xml.worksheet.sheetData.row)
    $header = @{}
    $records = foreach ($row in $rows) {
      $cells = @{}
      foreach ($c in $row.c) {
        $col = $c.r -replace '\d', ''
        $v = $c.v
        if ($c.t -eq 's') { $v = $strings[[int]$v] } elseif ($c.t -eq 'inlineStr') { $v = $c.is.InnerText }
        $cells[$col] = $v
      }
      if ($header.Count -eq 0) { foreach ($k in $cells.Keys) { $header[$cells[$k]] = $k }; continue }
      $cells
    }
    @{ header = $header; records = @($records) }
  }

  $emp = Read-Sheet 'EmployeeCashRatio'
  $des = Read-Sheet 'DesignationAverage'
} finally {
  $zip.Dispose()
}

$employees = [ordered]@{}
foreach ($r in $emp.records) {
  $code = [string]$r[$emp.header['EmployeeCode']]
  $ratio = $r[$emp.header['CashRatio']]
  if (-not $code -or -not $ratio) { continue }
  if ($employees.Contains($code)) { throw "Duplicate EmployeeCode $code in EmployeeCashRatio" }
  $employees[$code.Trim()] = [double]::Parse($ratio, [Globalization.CultureInfo]::InvariantCulture)
}

$designations = [ordered]@{}
foreach ($r in $des.records) {
  $name = [string]$r[$des.header['Designation']]
  $ratio = $r[$des.header['AvgCashRatio']]
  if (-not $name -or -not $ratio) { continue }
  $designations[$name.Trim()] = [double]::Parse($ratio, [Globalization.CultureInfo]::InvariantCulture)
}

$result = [ordered]@{
  source       = (Split-Path $Source -Leaf)
  generatedAt  = (Get-Date).ToString('s')
  employees    = $employees
  designations = $designations
}

$outDir = Split-Path $Out -Parent
if (-not (Test-Path $outDir)) { New-Item -ItemType Directory -Path $outDir | Out-Null }
# WriteAllText writes UTF-8 without a BOM, which JSON.parse expects.
[System.IO.File]::WriteAllText((Join-Path (Resolve-Path $outDir) (Split-Path $Out -Leaf)), ($result | ConvertTo-Json -Depth 4))
"Wrote $($employees.Count) employee ratios and $($designations.Count) designation ratios to $Out"
