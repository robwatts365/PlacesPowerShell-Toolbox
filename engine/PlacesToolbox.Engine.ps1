<#
Microsoft Places Toolbox: Engine
    Version: v1.0
    Date: 29/10/2026
    Author: Rob Watts (UC Rob) | watts365.com

    Long-running PowerShell 7 host for PlacesToolbox.hta. The HTA drops job
    files into <SessionPath>\queue; this engine runs each one in the same
    runspace (so Connect-MicrosoftPlaces / Connect-ExchangeOnline /
    Connect-MgGraph sessions persist) and streams output to <SessionPath>\out.

    Job protocol
        queue\<id>.ps1     script text (UTF-16 LE)
        queue\<id>.ready   JSON metadata, written last: { "maxRows": 5000, "outputFolder": "...", "label": "..." }
        out\<id>.log       streamed log lines  "<level>|<text>"
        out\<id>.progress  "<current>|<total>|<text>"
        out\<id>.json      result objects as JSON
        out\<id>.done      JSON status, written last
        out\<id>.cancel    created by the HTA to request a cancel
#>

param(
    [Parameter(Mandatory)][string]$SessionPath,
    [Parameter(Mandatory)][string]$ToolboxRoot,
    [int]$IdleTimeoutMinutes = 30
)

$ErrorActionPreference = 'Continue'
$ProgressPreference    = 'SilentlyContinue'
$ConfirmPreference     = 'None'   # the HTA confirms destructive actions itself; a console prompt would hang the job
$Host.UI.RawUI.WindowTitle = 'Watts365 Places Toolbox - engine (leave open)'

$TbxQueue   = Join-Path $SessionPath 'queue'
$TbxOut     = Join-Path $SessionPath 'out'
$TbxUnicode = [System.Text.UnicodeEncoding]::new($false, $true)
New-Item -ItemType Directory -Path $TbxQueue, $TbxOut -Force | Out-Null

################### START OF ENGINE FUNCTIONS ###################

### FUNCTION - Append a line to the current job log and the session log ###
function Add-TbxLogLine {
    param([string]$Level = 'host', [AllowEmptyString()][string]$Text = '')
    foreach ($Line in ($Text -replace "`r", '' -split "`n")) {
        if ($global:TbxJob) {
            try { [System.IO.File]::AppendAllText($global:TbxJob.Log, "$Level|$Line`r`n", $TbxUnicode) } catch { }
        }
        if ($global:TbxSessionLog -and $Level -ne 'out') {
            $Stamp = (Get-Date).ToString('yyyy/MM/dd HH:mm:ss')
            try { [System.IO.File]::AppendAllText($global:TbxSessionLog, "$Stamp :: [$Level] $Line`r`n") } catch { }
        }
    }
}

### FUNCTION - Public logging helper for recipes (levels: host, info, ok, warn, err, muted, accent) ###
function Write-TbxLog {
    param([Parameter(Position = 0)][string]$Message, [ValidateSet('host', 'info', 'ok', 'warn', 'err', 'muted', 'accent')][string]$Level = 'host')
    Add-TbxLogLine -Level $Level -Text $Message
}

### FUNCTION - Progress for the HTA progress bar ###
function Write-TbxProgress {
    param([int]$Current, [int]$Total, [string]$Text = '')
    if ($global:TbxJob) {
        try { [System.IO.File]::WriteAllText($global:TbxJob.Progress, "$Current|$Total|$Text", $TbxUnicode) } catch { }
    }
}

### FUNCTION - Throws if the user pressed Cancel in the HTA ###
function Test-TbxCancel {
    if ($global:TbxJob -and (Test-Path -LiteralPath $global:TbxJob.Cancel)) {
        throw [System.OperationCanceledException]::new('Cancelled by user.')
    }
}

### FUNCTION - Map a pipeline record onto a log level ###
function Out-TbxRecord {
    param($Record)
    switch ($Record) {
        { $_ -is [System.Management.Automation.ErrorRecord] } {
            $global:TbxJob.Errors++
            $Msg = $_.Exception.Message
            $Cmd = if ($_.InvocationInfo) { $_.InvocationInfo.MyCommand }
            if ($Cmd -and $Cmd.CommandType -in 'Cmdlet', 'Function' -and $Cmd.Name -ne 'Write-Error') { $Msg = "$($Cmd.Name): $Msg" }
            Add-TbxLogLine -Level 'err' -Text $Msg
            return
        }
        { $_ -is [System.Management.Automation.WarningRecord] } { Add-TbxLogLine -Level 'warn' -Text $_.Message; return }
        { $_ -is [System.Management.Automation.VerboseRecord] } { Add-TbxLogLine -Level 'muted' -Text "VERBOSE: $($_.Message)"; return }
        { $_ -is [System.Management.Automation.DebugRecord] } { Add-TbxLogLine -Level 'muted' -Text "DEBUG: $($_.Message)"; return }
        { $_ -is [System.Management.Automation.InformationRecord] } {
            $Level = 'host'
            $Data  = $_.MessageData
            if ($Data -is [System.Management.Automation.HostInformationMessage]) {
                $Level = switch -Regex ([string]$Data.ForegroundColor) {
                    '^(Green|DarkGreen)$'  { 'ok' }
                    '^(Red|DarkRed)$'      { 'err' }
                    '^(Yellow|DarkYellow)$'{ 'warn' }
                    '^(Cyan|DarkCyan)$'    { 'accent' }
                    '^(Gray|DarkGray)$'    { 'muted' }
                    default                { 'host' }
                }
                $Data = $Data.Message
            }
            Add-TbxLogLine -Level $Level -Text ([string]$Data)
            return
        }
        default {
            if ($null -eq $_) { return }
            if ($_ -is [string] -or $_ -is [ValueType]) {
                Add-TbxLogLine -Level 'out' -Text ([string]$_)
            }
            $global:TbxJob.Results.Add($_)
        }
    }
}

### FUNCTION - Serialise results for the HTA table ###
function Save-TbxResults {
    param([System.Collections.Generic.List[object]]$Results, [string]$Path, [int]$MaxRows)
    if ($Results.Count -eq 0) { return }
    $Rows = @($Results | Select-Object -First $MaxRows | ForEach-Object {
        if ($_ -is [string] -or $_ -is [ValueType]) { [PSCustomObject]@{ Value = $_ } } else { $_ }
    })
    try {
        $Json = ConvertTo-Json -InputObject $Rows -Depth 4 -Compress -WarningAction SilentlyContinue -ErrorAction Stop
    }
    catch {
        $Json = ConvertTo-Json -InputObject @($Rows | ForEach-Object { [PSCustomObject]@{ Value = ($_ | Out-String).Trim() } }) -Compress
    }
    [System.IO.File]::WriteAllText($Path, $Json, $TbxUnicode)
}

################### END OF ENGINE FUNCTIONS ###################

# Load recipes and helpers
. (Join-Path $ToolboxRoot 'engine\PlacesToolbox.Recipes.ps1')

# Engine ready marker
[System.IO.File]::WriteAllText((Join-Path $SessionPath 'engine.json'), (@{
    pid       = $PID
    psVersion = $PSVersionTable.PSVersion.ToString()
    started   = (Get-Date).ToString('o')
} | ConvertTo-Json -Compress), $TbxUnicode)

Write-Host "Watts365 Places Toolbox engine" -ForegroundColor Cyan
Write-Host "PowerShell $($PSVersionTable.PSVersion) | PID $PID" -ForegroundColor DarkGray
Write-Host "Session: $SessionPath" -ForegroundColor DarkGray
Write-Host "Leave this window open while the toolbox is running. Sign-in prompts may appear from here." -ForegroundColor DarkGray

$global:TbxResults = [ordered]@{}
$StopFile  = Join-Path $SessionPath 'stop'
$AliveFile = Join-Path $SessionPath 'ui.alive'

################### START OF ENGINE LOOP ###################
while ($true) {

    if (Test-Path -LiteralPath $StopFile) { break }
    if ((Test-Path -LiteralPath $AliveFile) -and
        ((Get-Date) - (Get-Item -LiteralPath $AliveFile).LastWriteTime).TotalMinutes -gt $IdleTimeoutMinutes) { break }

    $Ready = Get-ChildItem -LiteralPath $TbxQueue -Filter '*.ready' -ErrorAction SilentlyContinue | Sort-Object Name | Select-Object -First 1
    if (-not $Ready) { Start-Sleep -Milliseconds 200; continue }

    $JobId  = $Ready.BaseName
    $Meta   = try { Get-Content -LiteralPath $Ready.FullName -Raw | ConvertFrom-Json } catch { [PSCustomObject]@{} }
    $Script = Join-Path $TbxQueue "$JobId.ps1"
    Remove-Item -LiteralPath $Ready.FullName -Force -ErrorAction SilentlyContinue

    $global:TbxJob = [PSCustomObject]@{
        Id       = $JobId
        Log      = Join-Path $TbxOut "$JobId.log"
        Progress = Join-Path $TbxOut "$JobId.progress"
        Cancel   = Join-Path $TbxOut "$JobId.cancel"
        Results  = [System.Collections.Generic.List[object]]::new()
        Errors   = 0
    }

    # Output folder and session log follow whatever the HTA settings say
    if ($Meta.outputFolder) {
        $global:TbxOutputFolder = [string]$Meta.outputFolder
        $LogFolder = Join-Path $global:TbxOutputFolder 'Logs'
        New-Item -ItemType Directory -Path $LogFolder -Force -ErrorAction SilentlyContinue | Out-Null
        $global:TbxSessionLog = Join-Path $LogFolder ("PlacesToolbox-{0}.log" -f (Get-Date -Format 'yyyyMMdd'))
        # Work in the output folder so cmdlets that write files (Import-MapCorrelations, Get-Dataset) land there
        if ($global:TbxLastOutputFolder -ne $global:TbxOutputFolder) {
            Set-Location -LiteralPath $global:TbxOutputFolder -ErrorAction SilentlyContinue
            $global:TbxLastOutputFolder = $global:TbxOutputFolder
        }
    }
    $MaxRows = if ($Meta.maxRows) { [int]$Meta.maxRows } else { 5000 }

    [System.IO.File]::WriteAllText($global:TbxJob.Log, '', $TbxUnicode)
    if ($Meta.label -and -not $Meta.quiet) { Add-TbxLogLine -Level 'sys' -Text "> $($Meta.label)" }

    $Status = 'ok'; $Message = $null
    $Timer  = [System.Diagnostics.Stopwatch]::StartNew()
    try {
        $Code = Get-Content -LiteralPath $Script -Raw
        if ($Meta.label -and -not $Meta.quiet) { Add-TbxLogLine -Level 'cmd' -Text $Code.TrimEnd() }
        $Block = [scriptblock]::Create($Code)
        # Dot-sourced at script scope so variables persist between jobs (handy in the console)
        . $Block *>&1 | ForEach-Object { Out-TbxRecord $_ }
    }
    catch [System.OperationCanceledException] {
        $Status = 'cancelled'; $Message = $_.Exception.Message
        Add-TbxLogLine -Level 'warn' -Text $Message
    }
    catch {
        $Status = 'error'; $Message = $_.Exception.Message
        $global:TbxJob.Errors++
        Add-TbxLogLine -Level 'err' -Text $Message
    }
    $Timer.Stop()

    if ($Status -eq 'ok' -and $global:TbxJob.Errors -gt 0) { $Status = 'warn' }
    if (-not $Meta.quiet -and $global:TbxJob.Results.Count -gt 0) {
        $global:Last = $global:TbxJob.Results.ToArray()
        # Keep the last 20 result sets so the HTA can export them in full
        $global:TbxResults[$JobId] = $global:Last
        while ($global:TbxResults.Count -gt 20) { $global:TbxResults.RemoveAt(0) }
    }

    try { Save-TbxResults -Results $global:TbxJob.Results -Path (Join-Path $TbxOut "$JobId.json") -MaxRows $MaxRows }
    catch { Add-TbxLogLine -Level 'warn' -Text "Could not serialise results: $($_.Exception.Message)" }

    $Done = @{
        status  = $Status
        message = $Message
        errors  = $global:TbxJob.Errors
        count   = $global:TbxJob.Results.Count
        ms      = [int]$Timer.ElapsedMilliseconds
    } | ConvertTo-Json -Compress
    [System.IO.File]::WriteAllText((Join-Path $TbxOut "$JobId.done"), $Done, $TbxUnicode)
    Remove-Item -LiteralPath $Script -Force -ErrorAction SilentlyContinue
    $global:TbxJob = $null
}
################### END OF ENGINE LOOP ###################

Remove-Item -LiteralPath $SessionPath -Recurse -Force -ErrorAction SilentlyContinue
