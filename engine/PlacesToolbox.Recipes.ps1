<#
Microsoft Places Toolbox: Recipes
    Version: v1.0
    Date: 29/10/2026
    Author: Rob Watts (UC Rob) | watts365.com

    Multi-step workflows used by PlacesToolbox.hta. Dot-sourced by the engine,
    so Write-TbxLog, Write-TbxProgress and Test-TbxCancel are available.
    Every CSV recipe supports -DryRun: it validates each row against the
    live hierarchy but creates or changes nothing.
#>

################### START OF HELPER FUNCTIONS ###################

### FUNCTION - Output path inside the toolbox output folder ###
function Get-TbxOutputPath {
    param([Parameter(Mandatory)][string]$Name, [string]$Extension = 'csv', [string]$SubFolder = 'Reports')
    $Root = if ($global:TbxOutputFolder) { $global:TbxOutputFolder } else { Join-Path ([Environment]::GetFolderPath('MyDocuments')) 'Watts365 Places Toolbox' }
    $Folder = Join-Path $Root $SubFolder
    New-Item -ItemType Directory -Path $Folder -Force | Out-Null
    Join-Path $Folder ("{0}-{1}.{2}" -f $Name, (Get-Date -Format 'yyyyMMdd-HHmmss'), $Extension)
}

### FUNCTION - Import a CSV and check the required columns are present ###
function Import-TbxCsv {
    param([Parameter(Mandatory)][string]$Path, [string[]]$Required = @())
    if (-not (Test-Path -LiteralPath $Path)) { throw "CSV not found: $Path" }
    $Rows = @(Import-Csv -LiteralPath $Path)
    if ($Rows.Count -eq 0) { throw "CSV has no rows: $Path" }
    $Columns = $Rows[0].PSObject.Properties.Name
    $Missing = $Required | Where-Object { $_ -notin $Columns }
    if ($Missing) { throw "CSV is missing column(s): $($Missing -join ', '). Found: $($Columns -join ', ')" }
    Write-TbxLog "Loaded $($Rows.Count) row(s) from $Path" -Level muted
    $Rows
}

### FUNCTION - Flatten objects for CSV (nested objects to JSON, arrays to '; ' lists) ###
function ConvertTo-TbxFlat {
    process {
        $p = $_
        if ($null -eq $p) { return }
        if ($p -is [string] -or $p -is [ValueType]) { return [PSCustomObject]@{ Value = $p } }
        $o = [ordered]@{}
        foreach ($Prop in $p.PSObject.Properties) {
            $v = $Prop.Value
            $o[$Prop.Name] = if ($v -is [System.Collections.IDictionary] -or $v -is [System.Management.Automation.PSCustomObject]) { ConvertTo-Json -InputObject $v -Depth 3 -Compress }
                             elseif ($v -is [System.Collections.IEnumerable] -and $v -isnot [string]) { ($v | ForEach-Object { [string]$_ }) -join '; ' }
                             else { $v }
        }
        if ($p.Mode -and $p.Mode.Name) { $o['ModeName'] = $p.Mode.Name }
        [PSCustomObject]$o
    }
}

### FUNCTION - Export a stored result set from the HTA's Results tab (all rows, union of columns) ###
function Export-TbxResults {
    param([Parameter(Mandatory)][string]$JobId)
    if (-not $global:TbxResults.Contains($JobId)) { throw 'Those results are no longer held by the engine (it keeps the last 20). Run the command again.' }
    $Rows = @($global:TbxResults[$JobId] | ConvertTo-TbxFlat)
    $Columns = [System.Collections.Generic.List[string]]::new()
    foreach ($R in $Rows) { foreach ($N in $R.PSObject.Properties.Name) { if (-not $Columns.Contains($N)) { $Columns.Add($N) } } }
    $Out = Get-TbxOutputPath -Name 'Results' -SubFolder 'Exports'
    $Rows | Select-Object -Property $Columns | Export-Csv -LiteralPath $Out -NoTypeInformation -Encoding utf8
    Write-TbxLog "Saved $($Rows.Count) row(s): $Out" -Level ok
    Invoke-Item -LiteralPath $Out
}

### FUNCTION - First value of a possibly-array ParentId ###
function Get-TbxParentId { param($Place) @($Place.ParentId)[0] }

### FUNCTION - Load buildings, floors and sections once per run ###
function Get-TbxHierarchy {
    Write-TbxLog 'Loading buildings, floors and sections...' -Level muted
    $H = [PSCustomObject]@{
        Building = [System.Collections.Generic.List[object]]::new()
        Floor    = [System.Collections.Generic.List[object]]::new()
        Section  = [System.Collections.Generic.List[object]]::new()
    }
    foreach ($T in 'Building', 'Floor', 'Section') {
        @(Get-PlaceV3 -Type $T -ErrorAction Stop) | ForEach-Object { $H.$T.Add($_) }
    }
    Write-TbxLog "Found $($H.Building.Count) building(s), $($H.Floor.Count) floor(s), $($H.Section.Count) section(s)" -Level muted
    $H
}

### FUNCTION - Resolve one place by name (and parent) from the cached hierarchy ###
function Resolve-TbxPlace {
    param(
        [Parameter(Mandatory)]$Hierarchy,
        [Parameter(Mandatory)][ValidateSet('Building', 'Floor', 'Section')][string]$Type,
        [Parameter(Mandatory)][AllowEmptyString()][string]$Name,
        [string]$ParentId
    )
    if ([string]::IsNullOrWhiteSpace($Name)) { throw "$Type name is blank." }
    $Match = @($Hierarchy.$Type | Where-Object {
        $_.DisplayName -eq $Name -and (-not $ParentId -or (Get-TbxParentId $_) -eq $ParentId)
    })
    if ($Match.Count -ne 1) {
        $Where = if ($ParentId) { ' under the selected parent' } else { '' }
        throw "$Type '$Name' matched $($Match.Count) place(s)$Where - expected exactly 1."
    }
    $Match[0]
}

### FUNCTION - Resolve Building > Floor > (Section) by name ###
function Resolve-TbxPath {
    param($Hierarchy, [string]$Building, [string]$Floor, [string]$Section)
    $B = Resolve-TbxPlace -Hierarchy $Hierarchy -Type Building -Name $Building
    $F = Resolve-TbxPlace -Hierarchy $Hierarchy -Type Floor -Name $Floor -ParentId $B.PlaceId
    $S = if ($PSBoundParameters.ContainsKey('Section')) { Resolve-TbxPlace -Hierarchy $Hierarchy -Type Section -Name $Section -ParentId $F.PlaceId }
    [PSCustomObject]@{ Building = $B; Floor = $F; Section = $S }
}

### FUNCTION - Build a desk / workspace -Mode object (accepts the CSV friendly names) ###
function New-TbxDeskMode {
    param([string]$Mode = 'Reservable', [string]$User, [string]$Reason)
    $Metadata = [System.Collections.Generic.Dictionary[string, object]]::new()
    switch -Regex ($Mode.Trim()) {
        '^(New|Maintenance)$' { $Metadata.Add('Reason', $Matches[1]); return @{ Name = 'Unavailable'; Metadata = $Metadata } }
        '^Unavailable$' {
            $Metadata.Add('Reason', $(if ($Reason) { $Reason } else { 'New' }))
            return @{ Name = 'Unavailable'; Metadata = $Metadata }
        }
        '^Assigned$' {
            if ([string]::IsNullOrWhiteSpace($User)) { throw "Mode 'Assigned' needs a User email address." }
            $Metadata.Add('AssignedPersonEmailAddress', $User.Trim())
            return @{ Name = 'Assigned'; Metadata = $Metadata }
        }
        '^Drop-?in$' { return @{ Name = 'DropIn' } }
        '^(Reservable|)$' { return @{ Name = 'Reservable' } }
        default { throw "Unknown mode '$Mode'. Use Reservable, Drop-in, Assigned, New or Maintenance." }
    }
}

### FUNCTION - Shared row loop with progress, cancel, per-row error handling and summary ###
function Invoke-TbxRows {
    param(
        [Parameter(Mandatory)][object[]]$Rows,
        [Parameter(Mandatory)][scriptblock]$Action,
        [scriptblock]$Label = { "Row" },
        [switch]$DryRun
    )
    $Total = $Rows.Count; $i = 0; $Ok = 0; $Failed = 0
    if ($DryRun) { Write-TbxLog 'DRY RUN - nothing will be created or changed.' -Level warn }
    foreach ($Row in $Rows) {
        $i++
        Test-TbxCancel
        $Name = & $Label $Row
        Write-TbxProgress -Current $i -Total $Total -Text $Name
        try {
            $Result = & $Action $Row
            $Ok++
            Write-TbxLog "[$i/$Total] OK   $Name$(if ($Result) { " - $Result" })" -Level ok
        }
        catch {
            $Failed++
            Write-TbxLog "[$i/$Total] FAIL $Name - $($_.Exception.Message)" -Level err
        }
    }
    Write-TbxProgress -Current $Total -Total $Total -Text 'Complete'
    $Level = if ($Failed) { 'warn' } else { 'ok' }
    Write-TbxLog "Complete: $Ok succeeded, $Failed failed$(if ($DryRun) { ' (dry run)' })." -Level $Level
}

################### END OF HELPER FUNCTIONS ###################

################### START OF STATUS AND CONNECTION ###################

### FUNCTION - Module and connection status for the HTA header ###
function Get-TbxStatus {
    param([switch]$SkipPlacesCheck)
    $Modules = [ordered]@{}
    foreach ($M in 'MicrosoftPlaces', 'ExchangeOnlineManagement', 'Microsoft.Graph.Authentication', 'Microsoft.Graph.Users', 'Microsoft.Graph.Identity.DirectoryManagement') {
        $Found = Get-Module -ListAvailable -Name $M | Sort-Object Version -Descending | Select-Object -First 1
        $Modules[$M] = if ($Found) { $Found.Version.ToString() } else { $null }
    }

    # Places has no 'am I connected' cmdlet, so a cheap read is the test (only once the module is loaded)
    $Places = $false
    if ($SkipPlacesCheck) { $Places = [bool]$global:TbxPlacesConnected }
    elseif (Get-Module -Name MicrosoftPlaces) {
        try { Get-PlacesSettings -ErrorAction Stop | Out-Null; $Places = $true } catch { $Places = $false }
    }
    $global:TbxPlacesConnected = $Places

    $Exchange = $null
    if (Get-Command Get-ConnectionInformation -ErrorAction SilentlyContinue) {
        $Exchange = Get-ConnectionInformation -ErrorAction SilentlyContinue | Where-Object State -eq 'Connected' | Select-Object -First 1
    }
    $Graph = if (Get-Command Get-MgContext -ErrorAction SilentlyContinue) { Get-MgContext }

    [PSCustomObject]@{
        PSVersion       = $PSVersionTable.PSVersion.ToString()
        Modules         = $Modules
        Places          = $Places
        PlacesAccount   = $global:TbxPlacesAccount
        Exchange        = [bool]$Exchange
        ExchangeAccount = if ($Exchange) { $Exchange.UserPrincipalName }
        Graph           = [bool]$Graph
        GraphAccount    = if ($Graph) { $Graph.Account }
        GraphScopes     = if ($Graph) { ($Graph.Scopes -join ' ') }
    }
}

### FUNCTION - Connect to Microsoft Places ###
function Connect-TbxPlaces {
    if (-not (Get-Module -ListAvailable -Name MicrosoftPlaces)) { throw 'MicrosoftPlaces module is not installed. Install it from Setup.' }
    if (-not (Get-Module -Name MicrosoftPlaces)) {
        Write-TbxLog 'Importing MicrosoftPlaces module...' -Level muted
        Import-Module MicrosoftPlaces -ErrorAction Stop
    }
    try {
        Get-PlacesSettings -ReadFromPrimary -ErrorAction Stop | Out-Null
        Write-TbxLog 'Already connected to Microsoft Places.' -Level ok
    }
    catch {
        Write-TbxLog 'Connecting to Microsoft Places - sign in using the browser window that opens.' -Level accent
        Connect-MicrosoftPlaces -Confirm:$false -ErrorAction Stop
        Get-PlacesSettings -ErrorAction Stop | Out-Null
        Write-TbxLog 'Connected to Microsoft Places.' -Level ok
    }
    $global:TbxPlacesConnected = $true
}

### FUNCTION - Disconnect from Microsoft Places ###
function Disconnect-TbxPlaces {
    if (Get-Command Disconnect-MicrosoftPlaces -ErrorAction SilentlyContinue) { Disconnect-MicrosoftPlaces }
    $global:TbxPlacesConnected = $false
    Write-TbxLog 'Disconnected from Microsoft Places.' -Level ok
}

### FUNCTION - Connect to Exchange Online (calendar processing, room lists) ###
function Connect-TbxExchange {
    param([switch]$DisableWAM)
    if (-not (Get-Module -ListAvailable -Name ExchangeOnlineManagement)) { throw 'ExchangeOnlineManagement module is not installed. Install it from Setup.' }
    Import-Module ExchangeOnlineManagement -ErrorAction Stop
    Write-TbxLog 'Connecting to Exchange Online - sign in using the window that opens.' -Level accent
    $Params = @{ ShowBanner = $false; ErrorAction = 'Stop' }
    if ($DisableWAM) { $Params.DisableWAM = $true }
    Connect-ExchangeOnline @Params
    Write-TbxLog 'Connected to Exchange Online.' -Level ok
}

### FUNCTION - Connect to Microsoft Graph (licence checks, service plans) ###
function Connect-TbxGraph {
    param([string[]]$Scopes = @('User.Read.All', 'Directory.Read.All', 'Organization.Read.All'))
    if (-not (Get-Module -ListAvailable -Name Microsoft.Graph.Authentication)) { throw 'Microsoft.Graph modules are not installed. Install them from Setup.' }
    Write-TbxLog "Connecting to Microsoft Graph ($($Scopes -join ', ')) - sign in using the window that opens." -Level accent
    Connect-MgGraph -Scopes $Scopes -NoWelcome -ErrorAction Stop
    Write-TbxLog "Connected to Microsoft Graph as $((Get-MgContext).Account)." -Level ok
}

### FUNCTION - Install or update a module for the current user ###
function Install-TbxModule {
    param([Parameter(Mandatory)][string[]]$Name)
    foreach ($N in $Name) {
        Test-TbxCancel
        Write-TbxLog "Installing $N (CurrentUser)..." -Level accent
        Install-Module -Name $N -Scope CurrentUser -Force -AllowClobber -ErrorAction Stop
        $V = (Get-Module -ListAvailable -Name $N | Sort-Object Version -Descending | Select-Object -First 1).Version
        Write-TbxLog "$N $V installed." -Level ok
    }
    Write-TbxLog 'If you updated MicrosoftPlaces, restart the engine so the new version loads.' -Level muted
}

### FUNCTION - Slim index of all places for the HTA pickers and explorer ###
function Get-TbxPlaceIndex {
    foreach ($T in 'Building', 'Floor', 'Section', 'Room', 'Space', 'Desk') {
        Test-TbxCancel
        foreach ($P in @(Get-PlaceV3 -Type $T -ErrorAction Stop)) {
            $Email = foreach ($Prop in 'EmailAddress', 'PrimarySmtpAddress', 'Mailbox') { if ($P.$Prop) { [string]$P.$Prop; break } }
            [PSCustomObject]@{
                PlaceId     = [string]$P.PlaceId
                DisplayName = [string]$P.DisplayName
                Type        = $T
                ParentId    = [string](Get-TbxParentId $P)
                Email       = [string]$Email
                Mode        = [string]$P.Mode.Name
                Capacity    = $P.Capacity
                HasMap      = [bool]$P.HasMap
            }
        }
    }
}

################### END OF STATUS AND CONNECTION ###################

################### START OF CSV RECIPES: CREATE ###################

### RECIPE - Create a mixed hierarchy (Building/Floor/Section/Room/Desk/Workspace) from one CSV ###
function Import-TbxPlaceHierarchy {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'PlaceName', 'Type'
    $H = Get-TbxHierarchy
    $Order = @{ Building = 0; Floor = 1; Section = 2; Room = 3; Workspace = 4; Desk = 5 }
    # Parents first, so a single CSV can build a whole site
    $Rows = @($Rows | Sort-Object { if ($Order.ContainsKey($_.Type)) { $Order[$_.Type] } else { 9 } })

    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "$($r.Type) '$($r.PlaceName)'" } -Action {
        param($r)
        $Val = { param($v) if ([string]::IsNullOrWhiteSpace($v) -or $v -eq 'N/A') { $null } else { $v.Trim() } }
        $Params = @{ Type = $r.Type; Name = $r.PlaceName; ErrorAction = 'Stop' }
        switch ($r.Type) {
            'Building' {
                foreach ($Pair in @(@('Description', 'BuildingDescription'), @('CountryOrRegion', 'BuildingCountryCode'), @('State', 'BuildingState'),
                                    @('City', 'BuildingCity'), @('Street', 'BuildingStreet'), @('PostalCode', 'BuildingPostalCode'))) {
                    $v = & $Val $r.($Pair[1]); if ($v) { $Params[$Pair[0]] = $v }
                }
            }
            'Floor' {
                $B = Resolve-TbxPlace -Hierarchy $H -Type Building -Name $r.ParentBuildingName
                $Params.ParentId = $B.PlaceId
            }
            'Section' {
                $P = Resolve-TbxPath -Hierarchy $H -Building $r.ParentBuildingName -Floor $r.ParentFloorName
                $Params.ParentId = $P.Floor.PlaceId
            }
            'Room' {
                $P = Resolve-TbxPath -Hierarchy $H -Building $r.ParentBuildingName -Floor $r.ParentFloorName
                $Params.ParentId = $P.Floor.PlaceId
                $v = & $Val $r.Mailbox; if ($v) { $Params.Mailbox = $v }
                $v = & $Val $r.RoomCapacity; if ($v) { $Params.Capacity = [int]$v }
            }
            { $_ -in 'Desk', 'Workspace' } {
                $P = Resolve-TbxPath -Hierarchy $H -Building $r.ParentBuildingName -Floor $r.ParentFloorName -Section $r.ParentSectionName
                $Params.ParentId = $P.Section.PlaceId
                $Params.Mode = @{ Name = 'Reservable' }
                $v = & $Val $r.Mailbox; if ($v) { $Params.Mailbox = $v }
            }
            default { throw "Unknown Type '$($r.Type)'. Use Building, Floor, Section, Room, Workspace or Desk." }
        }
        if ($DryRun) { return 'validated' }
        $New = New-Place @Params
        # Make new parents resolvable by later rows in the same CSV
        if ($New -and $r.Type -in 'Building', 'Floor', 'Section') { $H.($r.Type).Add($New) }
        elseif (-not $New -and $r.Type -in 'Building', 'Floor', 'Section') {
            Write-TbxLog "  No object returned for $($r.PlaceName); child rows may need a re-run." -Level warn
        }
        if ($New.PlaceId) { "PlaceId $($New.PlaceId)" }
    }
}

### RECIPE - Create desks (any mode) from CSV ###
function New-TbxDesksFromCsv {
    param([Parameter(Mandatory)][string]$Path, [string]$DefaultMode = 'Reservable', [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'DeskName', 'BuildingName', 'FloorName', 'SectionName'
    $H = Get-TbxHierarchy
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "Desk '$($r.DeskName)'" } -Action {
        param($r)
        $P = Resolve-TbxPath -Hierarchy $H -Building $r.BuildingName -Floor $r.FloorName -Section $r.SectionName
        $ModeName = if ($r.PSObject.Properties['Mode'] -and $r.Mode) { $r.Mode } else { $DefaultMode }
        $Mode = New-TbxDeskMode -Mode $ModeName -User $r.User
        $Params = @{ Name = $r.DeskName; Type = 'Desk'; ParentId = $P.Section.PlaceId; Mode = $Mode; ErrorAction = 'Stop' }
        if ($r.Mailbox -and $Mode.Name -in 'Reservable', 'DropIn') { $Params.Mailbox = $r.Mailbox.Trim() }
        elseif ($r.Mailbox) { Write-TbxLog "  Mailbox ignored for $($Mode.Name) desk $($r.DeskName) (only Reservable and DropIn desks use one)." -Level muted }
        if ($DryRun) { return "validated as $($Mode.Name)" }
        New-Place @Params | Out-Null
        $Mode.Name
    }
}

### RECIPE - Create desk pools (Workspace places) from CSV ###
function New-TbxDeskPoolsFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'DeskPoolName', 'BuildingName', 'FloorName', 'SectionName'
    $H = Get-TbxHierarchy
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "Desk pool '$($r.DeskPoolName)'" } -Action {
        param($r)
        $P = Resolve-TbxPath -Hierarchy $H -Building $r.BuildingName -Floor $r.FloorName -Section $r.SectionName
        $Params = @{ Name = $r.DeskPoolName; Type = 'Workspace'; ParentId = $P.Section.PlaceId; Mode = @{ Name = 'Reservable' }; ErrorAction = 'Stop' }
        if ($r.Capacity) { $Params.Capacity = [int]$r.Capacity }
        if ($r.PSObject.Properties['Mailbox'] -and $r.Mailbox) { $Params.Mailbox = $r.Mailbox.Trim() }
        if ($DryRun) { return 'validated' }
        New-Place @Params | Out-Null
    }
}

### RECIPE - Create rooms from CSV ###
function New-TbxRoomsFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'RoomName', 'BuildingName', 'FloorName'
    $H = Get-TbxHierarchy
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "Room '$($r.RoomName)'" } -Action {
        param($r)
        $P = Resolve-TbxPath -Hierarchy $H -Building $r.BuildingName -Floor $r.FloorName
        $Params = @{ Name = $r.RoomName; Type = 'Room'; ParentId = $P.Floor.PlaceId; ErrorAction = 'Stop' }
        if ($r.Mailbox) { $Params.Mailbox = $r.Mailbox.Trim() }
        if ($r.Capacity) { $Params.Capacity = [int]$r.Capacity }
        if ($DryRun) { return 'validated' }
        New-Place @Params | Out-Null
    }
}

### RECIPE - Create many children of one type under one parent (from a list of names) ###
function New-TbxPlacesUnderParent {
    param(
        [Parameter(Mandatory)][ValidateSet('Building', 'Floor', 'Section', 'Room', 'Workspace', 'Desk')][string]$Type,
        [Parameter(Mandatory)][string[]]$Name,
        [string]$ParentId,
        [string]$DeskMode = 'Reservable',
        [switch]$DryRun
    )
    if ($Type -ne 'Building' -and -not $ParentId) { throw "A parent is required for $Type." }
    $Names = @($Name | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Invoke-TbxRows -Rows $Names -DryRun:$DryRun -Label { param($n) "$Type '$n'" } -Action {
        param($n)
        $Params = @{ Type = $Type; Name = $n; ErrorAction = 'Stop' }
        if ($ParentId) { $Params.ParentId = $ParentId }
        if ($Type -eq 'Desk') { $Params.Mode = New-TbxDeskMode -Mode $DeskMode }
        if ($Type -eq 'Workspace') { $Params.Mode = @{ Name = 'Reservable' } }
        if ($DryRun) { return 'validated' }
        $New = New-Place @Params
        if ($New.PlaceId) { "PlaceId $($New.PlaceId)" }
    }
}

################### END OF CSV RECIPES: CREATE ###################

################### START OF CSV RECIPES: UPDATE ###################

### RECIPE - Link existing room mailboxes into the hierarchy ###
function Set-TbxExistingRoomsFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'Mailbox', 'BuildingName', 'FloorName'
    $H = Get-TbxHierarchy
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "Room $($r.Mailbox)" } -Action {
        param($r)
        $P = Resolve-TbxPath -Hierarchy $H -Building $r.BuildingName -Floor $r.FloorName
        $Params = @{ Identity = $r.Mailbox.Trim(); ParentId = $P.Floor.PlaceId; ErrorAction = 'Stop' }
        if ($r.Capacity) { $Params.Capacity = [int]$r.Capacity }
        if ($r.PSObject.Properties['RoomName'] -and $r.RoomName) { $Params.DisplayName = $r.RoomName }
        if ($DryRun) { return "validated under $($P.Building.DisplayName) / $($P.Floor.DisplayName)" }
        Set-PlaceV3 @Params | Out-Null
        "$($P.Building.DisplayName) / $($P.Floor.DisplayName)"
    }
    Write-TbxLog 'Room and workspace changes can take up to 24 hours to show in Places.' -Level muted
}

### RECIPE - Move existing desks into a section and (optionally) link a mailbox ###
function Set-TbxDeskLocationFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'PlaceName', 'BuildingName', 'FloorName', 'SectionName'
    $H = Get-TbxHierarchy
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "Desk '$($r.PlaceName)'" } -Action {
        param($r)
        $P = Resolve-TbxPath -Hierarchy $H -Building $r.BuildingName -Floor $r.FloorName -Section $r.SectionName
        $Params = @{ Identity = $r.PlaceName; ParentId = $P.Section.PlaceId; ErrorAction = 'Stop' }
        if ($r.Mailbox) { $Params.Mailbox = $r.Mailbox.Trim() }
        if ($DryRun) { return 'validated' }
        Set-PlaceV3 @Params | Out-Null
    }
}

### RECIPE - Set desk modes (Reservable / Drop-in / Assigned / New / Maintenance) ###
function Set-TbxDeskModesFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'DeskName', 'Mode'
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "Desk '$($r.DeskName)'" } -Action {
        param($r)
        $Mode = New-TbxDeskMode -Mode $r.Mode -User $r.User
        if ($DryRun) { return "would set $($Mode.Name)" }
        Set-PlaceV3 -Identity $r.DeskName -Mode $Mode -ErrorAction Stop | Out-Null
        $Mode.Name
    }
}

### RECIPE - Replace tags on places (Tag1..Tag10 columns) ###
function Set-TbxTagsFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'PlaceName'
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "'$($r.PlaceName)'" } -Action {
        param($r)
        $Tags = @($r.PSObject.Properties | Where-Object { $_.Name -match '^Tag\d+$' -and -not [string]::IsNullOrWhiteSpace($_.Value) } |
                  Sort-Object { [int]($_.Name -replace '\D') } | ForEach-Object { $_.Value.Trim() })
        if ($DryRun) { return "tags: $($Tags -join ', ')" }
        Set-PlaceV3 -Identity $r.PlaceName -Tags $Tags -ErrorAction Stop | Out-Null
        "tags: $($Tags -join ', ')"
    }
}

### RECIPE - Building address and coordinates ###
function Set-TbxBuildingMetadataFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    $Rows = Import-TbxCsv -Path $Path -Required 'BuildingName'
    $H = Get-TbxHierarchy
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "Building '$($r.BuildingName)'" } -Action {
        param($r)
        $B = Resolve-TbxPlace -Hierarchy $H -Type Building -Name $r.BuildingName
        $Params = @{ Identity = $B.PlaceId; ErrorAction = 'Stop' }
        foreach ($Field in 'Street', 'City', 'State', 'PostalCode', 'CountryOrRegion') {
            if ($r.PSObject.Properties[$Field] -and -not [string]::IsNullOrWhiteSpace($r.$Field)) { $Params[$Field] = $r.$Field.Trim() }
        }
        if (-not [string]::IsNullOrWhiteSpace($r.Latitude) -and -not [string]::IsNullOrWhiteSpace($r.Longitude)) {
            $Params.GeoCoordinates = "$($r.Latitude.Trim());$($r.Longitude.Trim())"
        }
        $Set = ($Params.Keys | Where-Object { $_ -notin 'Identity', 'ErrorAction' }) -join ', '
        if ($DryRun) { return "would set $Set" }
        Set-PlaceV3 @Params | Out-Null
        "set $Set"
    }
}

################### END OF CSV RECIPES: UPDATE ###################

################### START OF REPORTS AND EXPORTS ###################

### RECIPE - Export every place beneath one or all buildings ###
function Export-TbxPlaceData {
    param([string[]]$BuildingId)
    $Buildings = @(Get-PlaceV3 -Type Building -ErrorAction Stop)
    if ($BuildingId) { $Buildings = @($Buildings | Where-Object PlaceId -in $BuildingId) }
    if (-not $Buildings) { throw 'No matching buildings found.' }
    $Out = Get-TbxOutputPath -Name $(if ($Buildings.Count -eq 1) { "PlaceData-$($Buildings[0].DisplayName -replace '[^\w\-]', '_')" } else { 'PlaceData-AllBuildings' })
    $All = [System.Collections.Generic.List[object]]::new()
    $i = 0
    foreach ($B in $Buildings) {
        $i++; Test-TbxCancel
        Write-TbxProgress -Current $i -Total $Buildings.Count -Text $B.DisplayName
        $All.Add($B)
        $Children = @(Get-PlaceV3 -AncestorId $B.PlaceId -ErrorAction Stop)
        $Children | ForEach-Object { $All.Add($_) }
        Write-TbxLog "$($B.DisplayName): $($Children.Count) place(s)" -Level muted
    }
    $All | ConvertTo-TbxFlat | Export-Csv -LiteralPath $Out -NoTypeInformation -Encoding utf8
    Write-TbxLog "Exported $($All.Count) place(s) to $Out" -Level ok
    [PSCustomObject]@{ File = $Out; Places = $All.Count }
}

### RECIPE - Desk status report (CSV + branded HTML) ###
function Get-TbxDeskStatusReport {
    param([switch]$OpenReport)
    $H = Get-TbxHierarchy
    $ById = @{}
    foreach ($T in 'Building', 'Floor', 'Section') { $H.$T | ForEach-Object { $ById[[string]$_.PlaceId] = $_ } }
    $Desks = @(Get-PlaceV3 -Type Desk -ErrorAction Stop | Sort-Object DisplayName)
    Write-TbxLog "Found $($Desks.Count) desk(s)" -Level muted

    $i = 0
    $Data = foreach ($D in $Desks) {
        $i++
        if ($i % 25 -eq 0) { Test-TbxCancel; Write-TbxProgress -Current $i -Total $Desks.Count -Text $D.DisplayName }
        $S = $ById[[string](Get-TbxParentId $D)]
        $F = if ($S) { $ById[[string](Get-TbxParentId $S)] }
        $B = if ($F) { $ById[[string](Get-TbxParentId $F)] }
        $Meta = $D.Mode.Metadata
        [PSCustomObject]@{
            BuildingName        = $B.DisplayName
            FloorName           = $F.DisplayName
            SectionName         = $S.DisplayName
            DeskName            = $D.DisplayName
            ModeName            = $D.Mode.Name
            UnavailableReason   = if ($D.Mode.Name -eq 'Unavailable' -and $Meta) { $Meta['Reason'] }
            AssignedPersonEmail = if ($D.Mode.Name -eq 'Assigned' -and $Meta) { $Meta['AssignedPersonEmailAddress'] }
            AssignedPersonId    = if ($D.Mode.Name -eq 'Assigned' -and $Meta) { $Meta['AssignedPersonId'] }
            PlaceId             = $D.PlaceId
        }
    }
    Write-TbxProgress -Current $Desks.Count -Total $Desks.Count -Text 'Writing report'

    $Csv  = Get-TbxOutputPath -Name 'DeskStatusReport'
    $Html = [System.IO.Path]::ChangeExtension($Csv, 'html')
    $Data | Export-Csv -LiteralPath $Csv -NoTypeInformation -Encoding utf8
    $Template = Get-Content -LiteralPath (Join-Path $ToolboxRoot 'engine\DeskStatusReport.template.html') -Raw
    $Json = ConvertTo-Json -InputObject @($Data) -Depth 2 -Compress
    $Template.Replace('__REPORTDATE__', (Get-Date -Format 'd MMMM yyyy, HH:mm')).Replace('/*__DATA__*/[]', $Json) |
        Set-Content -LiteralPath $Html -Encoding utf8
    Write-TbxLog "CSV:  $Csv" -Level ok
    Write-TbxLog "HTML: $Html" -Level ok
    if ($OpenReport) { Invoke-Item -LiteralPath $Html }
    $Data
}

### RECIPE - Desk licence compliance (needs Microsoft Graph) ###
function Test-TbxDeskLicensing {
    param([string[]]$ValidLicenses = @('M365_SHAREDSPACE', 'M365_SHAREDSPACE_SINGLESPACE', 'TEAMS_SHAREDDEVICE_LICENSE', 'MCOCAP', 'MICROSOFT_TEAMS_SHARED_SPACE_SINGLE_SPACE'))
    if (-not (Get-Command Get-MgContext -ErrorAction SilentlyContinue) -or -not (Get-MgContext)) { throw 'Not connected to Microsoft Graph. Connect Graph first.' }
    $Sku = @{}
    Get-MgSubscribedSku -ErrorAction Stop | ForEach-Object { $Sku[$_.SkuId.ToString()] = $_.SkuPartNumber }
    $Relevant = $Sku.Values | Sort-Object -Unique | Where-Object { $_ -match 'SPACE|SHARED|PLACE' }
    if ($Relevant) { Write-TbxLog "Tenant SKUs of interest: $($Relevant -join ', ')" -Level muted }

    $Desks = @(Get-PlaceV3 -Type Desk -ErrorAction Stop | Sort-Object DisplayName)
    $i = 0
    $Results = foreach ($D in $Desks) {
        $i++; Test-TbxCancel
        Write-TbxProgress -Current $i -Total $Desks.Count -Text $D.DisplayName
        $Mailbox = foreach ($Prop in 'MailboxOID', 'EmailAddress', 'Mailbox', 'PrimarySmtpAddress') { if ($D.$Prop) { $D.$Prop; break } }
        $Licences = @(); $Licensed = $false
        if ($Mailbox) {
            try {
                $U = Get-MgUser -UserId $Mailbox -Property AssignedLicenses -ErrorAction Stop
                $Licences = @($U.AssignedLicenses | ForEach-Object { $Sku[$_.SkuId.ToString()] } | Where-Object { $_ })
                $Licensed = [bool]($Licences | Where-Object { $_ -in $ValidLicenses })
            }
            catch { $Licences = @("Mailbox not found ($Mailbox)") }
        }
        else { $Licences = @('No mailbox on desk') }
        [PSCustomObject]@{
            DeskName   = $D.DisplayName
            Mode       = $D.Mode.Name
            Mailbox    = $Mailbox
            Licensed   = if ($Licensed) { 'Yes' } else { 'No' }
            Compliance = switch ($D.Mode.Name) {
                { $_ -in 'Reservable', 'DropIn' } { if ($Licensed) { 'Compliant' } else { 'Missing space licence' } }
                { $_ -in 'Unavailable', 'Assigned' } { 'Not required' }
                default { 'Review' }
            }
            Licences   = $Licences -join '; '
            PlaceId    = $D.PlaceId
        }
    }
    $Out = Get-TbxOutputPath -Name 'DeskLicenceCheck'
    $Results | Sort-Object Compliance, DeskName | Export-Csv -LiteralPath $Out -NoTypeInformation -Encoding utf8
    foreach ($G in ($Results | Group-Object Compliance)) {
        $Level = switch ($G.Name) { 'Compliant' { 'ok' } 'Missing space licence' { 'err' } 'Review' { 'warn' } default { 'muted' } }
        Write-TbxLog ("{0,-24} {1}" -f $G.Name, $G.Count) -Level $Level
    }
    Write-TbxLog "Saved: $Out" -Level ok
    $Results
}

################### END OF REPORTS AND EXPORTS ###################

################### START OF MAPS ###################

### RECIPE - Upload an IMDF map, optionally replacing the existing one ###
function Publish-TbxMap {
    param([Parameter(Mandatory)][string]$BuildingId, [Parameter(Mandatory)][string]$FilePath, [switch]$ReplaceExisting)
    if (-not (Test-Path -LiteralPath $FilePath)) { throw "Map file not found: $FilePath" }
    $B = Get-PlaceV3 -Identity $BuildingId -ErrorAction Stop
    if ($B.HasMap) {
        if (-not $ReplaceExisting) { throw "$($B.DisplayName) already has a map. Tick 'Replace existing map' to remove it first." }
        Write-TbxLog "Removing existing map from $($B.DisplayName)..." -Level warn
        Remove-Map -BuildingId $BuildingId -ErrorAction Stop
    }
    Write-TbxLog "Uploading $FilePath to $($B.DisplayName)..." -Level accent
    New-Map -BuildingId $BuildingId -FilePath $FilePath -ErrorAction Stop
    Write-TbxLog 'Map uploaded. It can take up to an hour to appear.' -Level ok
}

### RECIPE - Import-MapCorrelations run 1 or 2, working in the zip's folder ###
function Invoke-TbxMapCorrelation {
    param([Parameter(Mandatory)][string]$MapFilePath, [string]$CorrelationsFilePath)
    $Folder = Split-Path -Parent $MapFilePath
    Push-Location -LiteralPath $Folder
    try {
        if ($CorrelationsFilePath) {
            Write-TbxLog 'Run 2: writing correlations back into the IMDF zip...' -Level accent
            Import-MapCorrelations -MapFilePath $MapFilePath -CorrelationsFilePath $CorrelationsFilePath -ErrorAction Stop
        }
        else {
            Write-TbxLog 'Run 1: extracting map features to mapfeatures.csv...' -Level accent
            Import-MapCorrelations -MapFilePath $MapFilePath -ErrorAction Stop
            Write-TbxLog "Edit mapfeatures.csv (look in $Folder), then run step 2 with it." -Level ok
        }
    }
    finally { Pop-Location }
}

################### END OF MAPS ###################

################### START OF EXCHANGE AND GRAPH RECIPES ###################

### RECIPE - Auto-release settings for rooms and desks (Exchange Online) ###
function Set-TbxAutoReleaseFromCsv {
    param(
        [Parameter(Mandatory)][string]$Path,
        [int]$RoomClaimMinutes = 15, [int]$RoomBookingWindowDays = 365,
        [int]$DeskClaimMinutes = 60, [int]$DeskBookingWindowDays = 7, [bool]$DeskAllowRecurring = $false,
        [switch]$DryRun
    )
    if (-not (Get-Command Set-CalendarProcessing -ErrorAction SilentlyContinue)) { throw 'Not connected to Exchange Online. Connect Exchange first.' }
    $Rows = Import-TbxCsv -Path $Path -Required 'ID', 'Type'
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "$($r.Type) $($r.ID)" } -Action {
        param($r)
        $Params = switch ($r.Type) {
            'Room' { @{ PostReservationMaxClaimTimeInMinutes = $RoomClaimMinutes; BookingWindowInDays = $RoomBookingWindowDays } }
            'Desk' { @{ PostReservationMaxClaimTimeInMinutes = $DeskClaimMinutes; BookingWindowInDays = $DeskBookingWindowDays; AllowRecurringMeetings = $DeskAllowRecurring } }
            default { throw "Type must be Room or Desk (got '$($r.Type)')." }
        }
        $Summary = ($Params.GetEnumerator() | ForEach-Object { "$($_.Key)=$($_.Value)" }) -join ', '
        if ($DryRun) { return "would set $Summary" }
        Set-CalendarProcessing -Identity $r.ID -EnableAutoRelease $true @Params -ErrorAction Stop
        $Summary
    }
}

### RECIPE - Restrict booking to a group (BookInPolicy) ###
function Set-TbxBookInPolicyFromCsv {
    param([Parameter(Mandatory)][string]$Path, [switch]$DryRun)
    if (-not (Get-Command Set-CalendarProcessing -ErrorAction SilentlyContinue)) { throw 'Not connected to Exchange Online. Connect Exchange first.' }
    $Rows = Import-TbxCsv -Path $Path -Required 'SpaceID', 'GroupEmail'
    Invoke-TbxRows -Rows $Rows -DryRun:$DryRun -Label { param($r) "$($r.SpaceID)" } -Action {
        param($r)
        if ($DryRun) { return "would allow only $($r.GroupEmail)" }
        Set-CalendarProcessing -Identity $r.SpaceID -AutomateProcessing AutoAccept -BookInPolicy $r.GroupEmail -AllBookInPolicy $false -ErrorAction Stop
        "only $($r.GroupEmail) can book"
    }
}

### RECIPE - Create a room list and add members (Exchange Online) ###
function New-TbxRoomList {
    param([Parameter(Mandatory)][string]$Name, [string]$PrimarySmtpAddress, [string[]]$Members = @(), [switch]$DryRun)
    if (-not (Get-Command New-DistributionGroup -ErrorAction SilentlyContinue)) { throw 'Not connected to Exchange Online. Connect Exchange first.' }
    $Members = @($Members | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    if ($DryRun) { Write-TbxLog "DRY RUN - would create room list '$Name' with $($Members.Count) member(s)." -Level warn; return }
    $Params = @{ Name = $Name; RoomList = $true; ErrorAction = 'Stop' }
    if ($PrimarySmtpAddress) { $Params.PrimarySmtpAddress = $PrimarySmtpAddress }
    New-DistributionGroup @Params | Out-Null
    Write-TbxLog "Room list '$Name' created." -Level ok
    Invoke-TbxRows -Rows $Members -Label { param($m) $m } -Action {
        param($m)
        Add-DistributionGroupMember -Identity $Name -Member $m -ErrorAction Stop
    }
}

### RECIPE - Turn off Places Enhanced service plan for users (docs: How to turn off Microsoft Places, step 2) ###
function Disable-TbxPlacesEnhancedPlan {
    param([Parameter(Mandatory)][string[]]$UserPrincipalName, [switch]$DryRun)
    $PlanId = 'f8566154-2a62-48cb-a0ab-d4d25be26e51'
    if (-not (Get-Command Get-MgContext -ErrorAction SilentlyContinue) -or -not (Get-MgContext)) { throw 'Not connected to Microsoft Graph. Connect Graph with User.ReadWrite.All first.' }
    $Users = @($UserPrincipalName | ForEach-Object { $_.Trim() } | Where-Object { $_ })
    Invoke-TbxRows -Rows $Users -DryRun:$DryRun -Label { param($u) $u } -Action {
        param($u)
        $Changed = 0
        foreach ($L in @(Get-MgUserLicenseDetail -UserId $u -ErrorAction Stop)) {
            $Plan = $L.ServicePlans | Where-Object ServicePlanId -eq $PlanId
            if (-not $Plan -or $Plan.ProvisioningStatus -eq 'Disabled') { continue }
            $Disabled = @($L.ServicePlans | Where-Object ProvisioningStatus -eq 'Disabled' | ForEach-Object ServicePlanId) + $PlanId
            if (-not $DryRun) {
                Set-MgUserLicense -UserId $u -AddLicenses @(@{ SkuId = $L.SkuId; DisabledPlans = $Disabled }) -RemoveLicenses @() -ErrorAction Stop | Out-Null
            }
            $Changed++
        }
        if ($Changed) { "$(if ($DryRun) { 'would disable' } else { 'disabled' }) on $Changed licence(s)" } else { 'plan not present or already disabled' }
    }
    Write-TbxLog 'Assigning a Teams Premium licence later re-enables the plan.' -Level muted
}

################### END OF EXCHANGE AND GRAPH RECIPES ###################
