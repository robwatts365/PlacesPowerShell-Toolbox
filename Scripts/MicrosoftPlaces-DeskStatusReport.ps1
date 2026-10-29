<#
Microsoft Places: Desk Status Report
    Version: v1.2
    Date: 23/06/2026
    Author: github.com/robwatts365
#>

$Separator = "-" * 60

Write-Host ""
Write-Host $Separator -ForegroundColor DarkGray
Write-Host "Microsoft Places: Desk Status Report" -ForegroundColor Cyan
Write-Host "github.com/robwatts365" -ForegroundColor DarkGray
Write-Host $Separator -ForegroundColor DarkGray

# Check PowerShell version
Write-Host ""
Write-Host "  Checking PowerShell version..." -ForegroundColor Cyan
if ($PSVersionTable.PSVersion.Major -eq 7) {
    Write-Host "  OK   PowerShell $($PSVersionTable.PSVersion) detected" -ForegroundColor Green
}
else {
    Write-Host "  ERR  PowerShell 7 is required. Detected: $($PSVersionTable.PSVersion)" -ForegroundColor Red
    pause
    exit
}

# Check MicrosoftPlaces module
Write-Host ""
Write-Host "  Checking MicrosoftPlaces module..." -ForegroundColor Cyan
If (-not(Get-InstalledModule MicrosoftPlaces -ErrorAction SilentlyContinue)) {
    Write-Host "  ERR  MicrosoftPlaces module not found. Please install it before continuing." -ForegroundColor Red
}
Else {
    Write-Host "  OK   MicrosoftPlaces module found" -ForegroundColor Green
}

# Checks and Imports MicrosoftPlaces Module
if (-not (Get-Module -Name "MicrosoftPlaces")) {
    Write-Host "---------------------------------" -ForegroundColor Gray
    Write-Host "Importing Microsoft Places PowerShell Module..." -ForegroundColor Gray -BackgroundColor Black
    Import-Module MicrosoftPlaces
}
else {
    Write-Host "Microsoft Places PowerShell Module already imported..." -ForegroundColor Green
}

# Checks and Connects to Microsoft Places PowerShell Module
try {
    Get-PlacesSettings -ReadFromPrimary -ErrorAction Stop | Out-Null
    Write-Host "Already connected to Microsoft Places..." -ForegroundColor Green
}
catch {
    Write-Host "Not connected to Microsoft Places..." -ForegroundColor DarkRed
    Write-Host "---------------------------------" -ForegroundColor Gray
    Write-Host "Connecting to Microsoft Places...Sign in on the pop up browser window." -ForegroundColor Gray -BackgroundColor Black
    Connect-MicrosoftPlaces -Confirm:$false
    Write-Host "---------------------------------" -ForegroundColor Gray
    Write-Host "Connected to Microsoft Places..." -ForegroundColor Green
}

# Retrieve all desks
Write-Host ""
Write-Host "  Retrieving desks from Microsoft Places..." -ForegroundColor Cyan
$Desks = Get-PlaceV3 -Type Desk
$TotalDesks = @($Desks).Count
Write-Host "  OK   Found $TotalDesks desk(s)" -ForegroundColor Green

Write-Host ""
Write-Host $Separator -ForegroundColor DarkGray
Write-Host "  Processing Desks ($TotalDesks total)" -ForegroundColor Cyan
Write-Host $Separator -ForegroundColor DarkGray

$DeskData = [System.Collections.Generic.List[PSCustomObject]]::new()
$Counter  = 0

foreach ($Desk in $Desks) {

    $Counter++
    Write-Host ""
    Write-Host "  [$Counter/$TotalDesks] $($Desk.DisplayName)" -ForegroundColor White

    $DeskParentId = @($Desk.ParentId)[0]
    $Section = Get-Placev3 -Type Section -Id $DeskParentId
    Write-Host "       Section  » $($Section.DisplayName)" -ForegroundColor DarkGray

    $SectionParentId = @($Section.ParentId)[0]
    $Floor = Get-Placev3 -Type Floor -Id $SectionParentId
    Write-Host "       Floor    » $($Floor.DisplayName)" -ForegroundColor DarkGray

    $FloorParentId = @($Floor.ParentId)[0]
    $Building = Get-Placev3 -Type Building -Id $FloorParentId
    Write-Host "       Building » $($Building.DisplayName)" -ForegroundColor DarkGray

    $ModeName     = $Desk.Mode.Name
    $ModeMetadata = $Desk.Mode.Metadata

    # Flatten metadata into typed fields
    $MetaReason          = $null
    $MetaAssignedEmail   = $null
    $MetaAssignedId      = $null

    if ($ModeName -eq 'Unavailable') {
        $MetaReason = $ModeMetadata['Reason']
    }
    elseif ($ModeName -eq 'Assigned') {
        $MetaAssignedEmail = $ModeMetadata['AssignedPersonEmailAddress']
        $MetaAssignedId    = $ModeMetadata['AssignedPersonId']
    }

    Write-Host "       Mode     » $ModeName" -ForegroundColor DarkCyan

    $DeskData.Add([PSCustomObject]@{
        BuildingName         = $Building.DisplayName
        FloorName            = $Floor.DisplayName
        SectionName          = $Section.DisplayName
        DeskName             = $Desk.DisplayName
        ModeName             = $ModeName
        UnavailableReason    = $MetaReason
        AssignedPersonEmail  = $MetaAssignedEmail
        AssignedPersonId     = $MetaAssignedId
    })
}

Write-Host ""
Write-Host $Separator -ForegroundColor DarkGray
Write-Host "  OK   All $TotalDesks desk(s) processed" -ForegroundColor Green
Write-Host $Separator -ForegroundColor DarkGray

# ── CSV Export ───────────────────────────────────────────────────────────────

$ReportDate = Get-Date -Format "dd MMM yyyy HH:mm"
$CsvPath  = Join-Path $PSScriptRoot "DeskStatusReport.csv"
$HtmlPath = Join-Path $PSScriptRoot "DeskStatusReport.html"

Write-Host ""
Write-Host "  Generating CSV report..." -ForegroundColor Cyan
$DeskData | Export-Csv -Path $CsvPath -NoTypeInformation -Encoding utf8 -Force
Write-Host "  OK   Report saved to: $CsvPath" -ForegroundColor Green

# ── Basic HTML Report ────────────────────────────────────────────────────────

Write-Host ""
Write-Host "  Generating HTML report..." -ForegroundColor Cyan

$Rows = foreach ($d in $DeskData) {
    "<tr><td>$($d.BuildingName)</td><td>$($d.FloorName)</td><td>$($d.SectionName)</td><td>$($d.DeskName)</td><td>$($d.ModeName)</td><td>$($d.UnavailableReason)</td><td>$($d.AssignedPersonEmail)</td><td>$($d.AssignedPersonId)</td></tr>"
}

$Html = @"
<!DOCTYPE html>
<html>
<head>
<meta charset="UTF-8">
<title>Desk Status Report</title>
</head>
<body>
<h1>Desk Status Report</h1>
<p>Generated: $ReportDate</p>
<table border="1">
<tr><th>Building</th><th>Floor</th><th>Section</th><th>Desk</th><th>Mode</th><th>Unavailable Reason</th><th>Assigned Person Email</th><th>Assigned Person Id</th></tr>
$($Rows -join "`n")
</table>
</body>
</html>
"@

$Html | Out-File -FilePath $HtmlPath -Encoding utf8 -Force
Write-Host "  OK   Report saved to: $HtmlPath" -ForegroundColor Green

Write-Host ""
Write-Host $Separator -ForegroundColor DarkGray
Write-Host "  Complete  |  Opening reports..." -ForegroundColor Cyan
Write-Host $Separator -ForegroundColor DarkGray
Write-Host ""

Invoke-Item $CsvPath
Invoke-Item $HtmlPath
