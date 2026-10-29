# Places Toolbox

**Watts365 by UC Rob** · [watts365.com](https://watts365.com)

Places Toolbox is a Windows app (an HTA) that puts every Microsoft Places PowerShell cmdlet into a form, alongside recipes for bulk jobs. You fill in the form, check the command preview, and run it. It works in the same signed-in PowerShell session the whole time.

It covers every cmdlet in [Microsoft Places PowerShell](https://learn.microsoft.com/en-us/microsoft-365/places/), and turns my field scripts into repeatable, dry-runnable recipes. Those include building a whole site from one CSV, setting desk modes in bulk, reports, map uploads and Exchange calendar policy.

> An independent community tool. It isn't made, endorsed or supported by Microsoft. Views are my own.

## What you need

| | |
|---|---|
| Windows 10 or 11 | `mshta.exe` must be allowed. Some security baselines and attack surface reduction (ASR) rules block it. |
| PowerShell 7.4 or later | `winget install --id Microsoft.PowerShell --source winget` |
| MicrosoftPlaces module | 2.0.0 or later recommended. The Home page installs or updates it. |
| Roles | Places Administrator, Exchange Administrator, or a custom role with TenantPlacesManagement. Roles assigned through an Entra **group** aren't honoured by Places, so assign them directly. |
| Optional | ExchangeOnlineManagement (calendar processing and room lists), and Microsoft.Graph (licence recipes). Both install from Home. |

## Getting started

1. Download or clone this repo.
2. If you downloaded a zip, unblock it before extracting. Right-click it, choose **Properties**, then **Unblock**. Or run `Get-ChildItem -Recurse | Unblock-File` in the folder.
3. Double-click `PlacesToolbox.hta`.
4. On **Home**, install any missing modules, then choose **Connect** next to Microsoft Places. Sign in using the browser window that opens.
5. Pick a cmdlet or recipe from the left, fill it in and choose **Run**. For recipes, choose **Dry run** first.

## How it works

```
PlacesToolbox.hta  ──job files──▶  engine\PlacesToolbox.Engine.ps1  (PowerShell 7, one long-lived session)
   (UI, IE11 engine) ◀──log, progress, results──┘
```

- The HTA starts one PowerShell 7 **engine**, minimised in a classic console window, and talks to it through files in `%LOCALAPPDATA%\Watts365\PlacesToolbox\Sessions`.
- Every command runs in that one session. You connect once, and variables persist between runs. `$Last` always holds the previous results.
- **Output** shows the coloured log. **Results** shows any objects a command returned: filter, sort, copy or export them to CSV. **History** lists everything you've run this session.
- Destructive cmdlets (`Remove-Place`, `Remove-Map`, `Set-PlacesSettings`, `Set-PlaceDevice`, `Remove-PlaceDevice`) ask you to confirm the exact command first.
- **Cancel** stops a recipe at its next row. A single cmdlet can't be interrupted mid-call. If one is stuck, use **Restart engine** on Home.
- Nothing is sent anywhere except Microsoft's own sign-in and service endpoints. Fonts load from Google Fonts. If they're blocked, the app falls back to Segoe UI and Consolas.

## Cmdlets

All 19 documented cmdlets have a form. The form generator handles the parameter quirks:

- **Workspaces:** the `Space` vs `Workspace` naming.
- **Desk modes:** the `Mode` metadata dictionary.
- **Set-PlacesSettings:** its scope strings, including group OIDs.
- **ResourceLinks and sensors:** their object syntax.
- **Places:** a picker backed by your live hierarchy.

| Group | Cmdlets |
|---|---|
| General | Connect-MicrosoftPlaces, Disconnect-MicrosoftPlaces, Get-PlacesSettings, Set-PlacesSettings |
| Directory | Initialize-Places *(opens in its own window: it's interactive)*, Get-PlaceV3, New-Place, Set-PlaceV3, Remove-Place |
| Analytics | Push-Dataset, Get-Dataset, Get-DatasetStatus |
| Maps | Import-MapCorrelations, New-Map, Remove-Map |
| Devices & sensors | Get-PlaceDevice, New-PlaceDevice, Set-PlaceDevice *(with Load current values)*, Remove-PlaceDevice |

## Recipes

Every CSV recipe supports **Dry run**. A dry run resolves each row against your live buildings, floors and sections and reports what would happen, without changing anything. Choose **Open CSV template** on a recipe to get a starter file, copied into your output folder.

| Recipe | What it does | CSV columns |
|---|---|---|
| Whole site from one CSV | Creates buildings, floors, sections, rooms, workspaces and desks, parents first | `PlaceName, Type, Mailbox, ParentBuildingName, ParentFloorName, ParentSectionName, Building*, RoomCapacity` |
| Desks from CSV | Creates desks with a mode per row: Reservable, Drop-in, Assigned (with User), New or Maintenance | `DeskName, Mailbox, BuildingName, FloorName, SectionName, Mode, User` |
| Desk pools from CSV | Creates reservable Workspace places | `DeskPoolName, Capacity, BuildingName, FloorName, SectionName` |
| Rooms from CSV | Creates rooms on floors | `RoomName, Mailbox, Capacity, BuildingName, FloorName` |
| Many places under one parent | Pastes a list of names under one building, floor or section | *(no CSV)* |
| Link existing rooms | Puts existing room mailboxes on floors | `Mailbox, BuildingName, FloorName, Capacity` |
| Move desks to sections | Re-parents desks and links mailboxes | `PlaceName, Mailbox, BuildingName, FloorName, SectionName` |
| Desk modes | Sets modes in bulk | `DeskName, Mode, User` |
| Tags | Replaces tags | `PlaceName, Tag1 … Tag10` |
| Building addresses | Sets address and coordinates | `BuildingName, Street, City, State, PostalCode, CountryOrRegion, Latitude, Longitude` |
| Desk status report | Every desk with its location and mode, as CSV plus a filterable HTML page | |
| Place data export | Every place under one or all buildings, as CSV | |
| Desk licence check | Shared-space licence compliance for Reservable and Drop-in desks (Graph) | |
| Map correlation | Runs `Import-MapCorrelations` steps 1 and 2 in the zip's folder | |
| Upload map (replace) | `New-Map`, optionally removing the existing map first | |
| Auto-release | `Set-CalendarProcessing` auto-release, with separate room and desk settings (Exchange) | `ID, Type` |
| Restrict booking to a group | BookInPolicy set to a group (Exchange) | `SpaceID, GroupEmail` |
| New room list | Creates a room list and adds rooms to it (Exchange) | |
| Turn off Places (steps 1 and 2) | Microsoft's documented switch-off: settings, then the Places Enhanced service plan (Graph) | |

## Where things go

Everything goes to the output folder you set on Home. The default is `Documents\Watts365 Places Toolbox`.

- `Reports\`: desk status, licence check and place exports
- `Exports\`: Results tab exports
- `Templates\`: CSV templates you've opened
- `Logs\PlacesToolbox-yyyyMMdd.log`: a timestamped log of everything run

## Troubleshooting

- **Connect seems to hang.** Sign-in opens in your browser, or for Exchange in a Microsoft sign-in window, which may be behind other windows. Choose **Engine window** to bring the engine forward.
- **Behind a proxy.** PowerShell 7 doesn't pick up the system proxy. Configure it with `netsh winhttp set proxy`.
- **Exchange sign-in doesn't appear.** On Home, tick *Exchange: sign in through the browser (-DisableWAM)* and connect again.
- **Engine won't start.** On Home, tick *Start the engine window visible* and restart the engine to see the error. If Windows Terminal grabs the window, keep *classic console* ticked.
- **Room and workspace changes don't show.** `Set-PlaceV3` changes to rooms and workspaces can take up to 24 hours. Maps can take up to an hour.

## Files

```
PlacesToolbox.hta                     the app
app\                                  UI: styles, catalogue of cmdlets and recipes, logic, icon
engine\PlacesToolbox.Engine.ps1       PowerShell 7 job host
engine\PlacesToolbox.Recipes.ps1      recipe functions (usable on their own: dot-source it)
engine\DeskStatusReport.template.html report template
templates\                            starter CSVs
```

The recipe functions also work without the UI. Dot-source `engine\PlacesToolbox.Recipes.ps1` after defining stub `Write-TbxLog`, `Write-TbxProgress` and `Test-TbxCancel` functions.

---

Rob Watts (UC Rob) · [watts365.com](https://watts365.com) · MIT licence
