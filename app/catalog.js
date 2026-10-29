/*
  Watts365 Places Toolbox - catalogue
  Every cmdlet documented under learn.microsoft.com/microsoft-365/places/powershell,
  plus the toolbox recipes. The UI is generated from these definitions.

  Parameter fields
    n     name             t     type: str|int|bool|switch|enum|file|folder|place|device|mode|list|lines|links|sensors|scope|date|text
    req   required          sets  parameter sets the field belongs to (omit = all)
    v     enum values       help  help text          ph  placeholder
    pick  place picker      { types: [...] | bySet: {Set: [...]}, value: 'id' | 'email' }
    ext   file filter       emit  name to emit when it differs from n (or false for UI-only)
    def   default value
*/

var DOCS = 'https://learn.microsoft.com/en-us/microsoft-365/places/powershell/';

var GEO_HELP = 'Latitude;longitude[;altitude], e.g. 51.501393;-0.141849. Use commas if periods fail in your locale.';
var LINKS_HELP = 'One link per line: name | value | Url or MetaOsApp. Replaces the whole set.';
var TAGS_HELP = 'Comma-separated. Replaces the whole set of tags.';
var SCOPE_HELP = "Builds the scope string, e.g. 'Default:false,OID:<group OID>@<tenant ID>:true'. Group must be mail-enabled security. Max 20 OIDs.";

var CMDLETS = [
  /* ── General ── */
  { id: 'Connect-MicrosoftPlaces', group: 'General', after: 'status',
    synopsis: 'Opens a connection to Microsoft Places using modern authentication (MFA supported). A browser window opens for sign-in.',
    notes: ['Permissions are not checked at connect time; they apply when you run other cmdlets.',
            'PowerShell 7 does not pick up the system proxy automatically. If sign-in fails behind a proxy, configure it with netsh winhttp set proxy.'],
    params: [] },
  { id: 'Disconnect-MicrosoftPlaces', group: 'General', after: 'status',
    synopsis: 'Disconnects the sessions created by Connect-MicrosoftPlaces and clears the token cache.', params: [] },
  { id: 'Get-PlacesSettings', group: 'General',
    synopsis: 'Shows the Places feature settings configured for the tenant.',
    notes: ['Requires Exchange Admin or the TenantPlacesManagement role.', 'Only EnableBuildings, EnablePlacesWebApp, PlacesFinderEnabled and SpaceAnalyticsEnabled are documented; other settings in the output are unsupported.'],
    params: [ { n: 'ReadFromPrimary', t: 'switch', help: 'Read from primary storage instead of the cache. Without it, results can be stale.' } ] },
  { id: 'Set-PlacesSettings', group: 'General', danger: 'This changes Places features for your whole tenant (or the groups you scope). Changes take up to 12 hours to apply.',
    synopsis: 'Turns Places features on or off for the tenant, or for a subset of users.',
    notes: ['Requires both the Exchange MailRecipients role and TenantPlacesManagement. Roles assigned through an Entra group are not honoured.',
            'OID scoping is currently only supported for PlacesFinderEnabled.',
            'Find a group OID: Get-MgGroup -Filter "DisplayName eq \'<name>\'" | Select Id, or Get-DistributionGroup \'<name>\' | Select ExternalDirectoryObjectId.'],
    params: [
      { n: 'EnableBuildings', t: 'scope', help: 'Shows buildings in Work plans, Workplace presence, Places finder and more. Only takes effect once buildings and floors exist.' },
      { n: 'EnablePlacesWebApp', t: 'scope', help: 'Access to Places on the web and in Outlook, Teams and the Microsoft 365 app.' },
      { n: 'PlacesFinderEnabled', t: 'scope', oid: true, help: 'Places finder and desk booking. Supports group (OID) scoping.' },
      { n: 'SpaceAnalyticsEnabled', t: 'scope', help: 'Access to space analytics. Off by default.' }
    ] },

  /* ── Directory ── */
  { id: 'Initialize-Places', group: 'Directory', external: true,
    synopsis: 'Quick-create wizard: infers buildings, floors and sections from your existing rooms, workspaces and room lists, then creates the hierarchy.',
    notes: ['Initialize-Places is interactive, so the toolbox opens it in its own PowerShell 7 window, signed in and working in your output folder.',
            'Option 1 exports ResourceAccountsMapped.csv (suggested mapping). Option 2 imports a mapping CSV and creates places. Option 3 exports PlacesOnboardingScript.ps1 without running it.',
            'Import CSV columns: InferredBuildingName, InferredFloorName, InferredSectionName (required for workspaces), PrimarySmtpAddress. Spell names identically or you will get duplicates.',
            'Changes made by Initialize-Places show immediately, unlike Set-PlaceV3, which can take up to 24 hours.'],
    template: 'InitializePlacesImport.csv', params: [] },
  { id: 'Get-PlaceV3', group: 'Directory',
    synopsis: 'Shows metadata for rooms, room lists, workspaces, buildings, floors, sections and desks.',
    notes: ['Use -Identity or -Type, not both. -AncestorId returns everything below a place in the hierarchy.'],
    validate: function (v) { if (v.Identity && v.Type) return 'Use either Identity or Type, not both.'; },
    params: [
      { n: 'Identity', t: 'place', pick: { types: ['Building', 'Floor', 'Section', 'Desk', 'Room', 'Space'], value: 'auto' }, help: 'Email address for mailbox places (rooms, workspaces); PlaceId or Name_PlaceId for everything else.' },
      { n: 'AncestorId', t: 'place', pick: { types: ['Building', 'Floor', 'Section'], value: 'id' }, help: 'Returns every place beneath this one.' },
      { n: 'Type', t: 'enum', v: ['Building', 'Floor', 'Section', 'Desk', 'Room', 'Space', 'RoomList'], help: 'Workspaces are "Space" here (New-Place calls them Workspace).' }
    ] },
  { id: 'New-Place', group: 'Directory', setParam: 'Type', sets: ['Building', 'Floor', 'Section', 'Room', 'Workspace', 'Desk'], after: 'index',
    synopsis: 'Creates a building, floor, section, room, workspace (desk pool) or desk.',
    notes: ['Parents: a floor sits in a building, a section in a floor, a room in a floor or section, and workspaces and desks in a section.',
            'Rooms and workspaces get a mailbox automatically (Places Admin, Exchange Admin or Global Admin needed); this can take up to 24 hours.',
            'Desks: with no Mode they are created Unavailable with no mailbox. Reservable and DropIn desks create or link a mailbox; Assigned and Unavailable do not.'],
    params: [
      { n: 'Name', t: 'str', req: true, help: 'Display name, up to 200 characters. (Documented as -DisplayName; Microsoft\'s examples use -Name.)' },
      { n: 'ParentId', t: 'place', sets: ['Floor', 'Section', 'Room', 'Workspace', 'Desk'], pick: { bySet: { Floor: ['Building'], Section: ['Floor'], Room: ['Floor', 'Section'], Workspace: ['Section'], Desk: ['Section'] }, value: 'id' } },
      { n: 'Label', t: 'str', help: 'Optional label, up to 200 characters.' },
      { n: 'Description', t: 'str', sets: ['Building'], help: 'Used in Microsoft\'s building example.' },
      { n: 'Street', t: 'str', sets: ['Building'] },
      { n: 'City', t: 'str', sets: ['Building'] },
      { n: 'State', t: 'str', sets: ['Building'] },
      { n: 'PostalCode', t: 'str', sets: ['Building'] },
      { n: 'CountryOrRegion', t: 'str', sets: ['Building'], ph: 'GB', help: 'ISO 3166-1 two-letter code or a friendly name.' },
      { n: 'GeoCoordinates', t: 'str', sets: ['Building', 'Desk'], ph: '51.501393;-0.141849', help: GEO_HELP },
      { n: 'SortOrder', t: 'int', sets: ['Floor'], help: 'Floor ordering, e.g. Lobby = 0.' },
      { n: 'Capacity', t: 'int', sets: ['Room', 'Workspace'] },
      { n: 'Mailbox', t: 'str', sets: ['Room', 'Workspace', 'Desk'], ph: 'desk101@contoso.com', help: 'Links an existing mailbox, or creates one with this address. A desk\'s mailbox must be resource type Desk.' },
      { n: 'Mode', t: 'mode', sets: ['Desk', 'Workspace'] },
      { n: 'Tags', t: 'list', sets: ['Building', 'Floor'], help: TAGS_HELP },
      { n: 'ResourceLinks', t: 'links', sets: ['Building'], help: LINKS_HELP }
    ] },
  { id: 'Set-PlaceV3', group: 'Directory', setParam: 'Kind', setEmit: false, sets: ['Building', 'Floor', 'Section', 'Room', 'Workspace', 'Desk'], after: 'index',
    synopsis: 'Updates metadata on buildings, floors, sections, rooms, workspaces and desks.',
    notes: ['Room and workspace changes can take up to 24 hours to show.',
            'Tags, ResourceLinks and Mode replace the whole existing value.',
            'In Exchange hybrid, address fields, GeoCoordinates and Phone cannot be set on synced room mailboxes. Address fields are ignored on parented rooms and workspaces; set them on the building.',
            'Moving a desk from Unavailable to Reservable creates a mailbox automatically.'],
    validate: function (v) { var n = 0; for (var k in v) if (k !== 'Identity' && v[k] !== '' && v[k] != null) n++; if (!n) return 'Set at least one property to change.'; },
    params: [
      { n: 'Identity', t: 'place', req: true, pick: { bySet: { Building: ['Building'], Floor: ['Floor'], Section: ['Section'], Room: ['Room'], Workspace: ['Space'], Desk: ['Desk'] }, value: 'auto' }, help: 'Email address for rooms and workspaces; name or PlaceId for buildings, floors, sections and desks.' },
      { n: 'DisplayName', t: 'str', help: 'Renaming a mailbox place needs Places Admin, Exchange Admin or Global Admin.' },
      { n: 'Label', t: 'str' },
      { n: 'ParentId', t: 'place', sets: ['Floor', 'Section', 'Room', 'Workspace', 'Desk'], pick: { bySet: { Floor: ['Building'], Section: ['Floor'], Room: ['Floor', 'Section'], Workspace: ['Section'], Desk: ['Section'] }, value: 'id' } },
      { n: 'SortOrder', t: 'int', sets: ['Floor'] },
      { n: 'Capacity', t: 'int', sets: ['Room', 'Workspace'], help: 'Also updates the mailbox.' },
      { n: 'Mailbox', t: 'str', sets: ['Desk'] },
      { n: 'Mode', t: 'mode', sets: ['Desk', 'Workspace'] },
      { n: 'Tags', t: 'list', sets: ['Desk', 'Room', 'Workspace'], help: TAGS_HELP },
      { n: 'IsWheelChairAccessible', t: 'bool', sets: ['Building', 'Desk', 'Room', 'Workspace'] },
      { n: 'MTREnabled', t: 'bool', sets: ['Room', 'Workspace'], help: 'The room has a Microsoft Teams Rooms system.' },
      { n: 'AudioDeviceName', t: 'str', sets: ['Room', 'Workspace'] },
      { n: 'VideoDeviceName', t: 'str', sets: ['Room', 'Workspace'] },
      { n: 'DisplayDeviceName', t: 'str', sets: ['Desk', 'Room', 'Workspace'] },
      { n: 'GeoCoordinates', t: 'str', sets: ['Building', 'Room', 'Workspace'], ph: '51.501393;-0.141849', help: GEO_HELP },
      { n: 'Phone', t: 'str', sets: ['Building', 'Room', 'Workspace'] },
      { n: 'Street', t: 'str', sets: ['Building'] },
      { n: 'City', t: 'str', sets: ['Building'] },
      { n: 'State', t: 'str', sets: ['Building'] },
      { n: 'PostalCode', t: 'str', sets: ['Building'] },
      { n: 'CountryOrRegion', t: 'str', sets: ['Building'], ph: 'GB' },
      { n: 'ResourceLinks', t: 'links', sets: ['Building'], help: LINKS_HELP },
      { n: 'Building', t: 'str', sets: ['Room'], help: 'Deprecated. Only for legacy Outlook Room Finder compatibility.' },
      { n: 'Floor', t: 'int', sets: ['Room'], help: 'Deprecated. Only for legacy Outlook Room Finder compatibility.' },
      { n: 'FloorLabel', t: 'str', sets: ['Room'], help: 'Deprecated. Only for legacy Outlook Room Finder compatibility.' }
    ] },
  { id: 'Remove-Place', group: 'Directory', danger: 'This deletes the place. Any linked mailbox is soft-deleted and kept for 30 days.', after: 'index',
    synopsis: 'Deletes a building, floor, section, room, workspace or desk.',
    notes: ['A place with children cannot be removed. Move or remove the children first.'],
    params: [ { n: 'Identity', t: 'place', req: true, pick: { types: ['Building', 'Floor', 'Section', 'Desk', 'Room', 'Space'], value: 'id' }, help: 'PlaceId or Name_PlaceId.' } ] },

  /* ── Analytics ── */
  { id: 'Push-Dataset', group: 'Analytics',
    synopsis: 'Uploads occupancy, people-count or badge-swipe data for Places analytics.',
    notes: ['Uploads count as today\'s data. Pushing again on the same day overwrites the earlier upload.'],
    params: [
      { n: 'Type', t: 'enum', req: true, v: ['roomoccupancy', 'peoplecount', 'badgeswipe'] },
      { n: 'Path', t: 'folder', req: true, help: 'A folder containing the .csv files to upload.' },
      { n: 'DeviceType', t: 'enum', v: ['Standard'] }
    ] },
  { id: 'Get-Dataset', group: 'Analytics',
    synopsis: 'Downloads a dataset CSV that was pushed earlier.',
    params: [
      { n: 'Type', t: 'enum', v: ['roomoccupancy', 'peoplecount', 'badgeswipe'] },
      { n: 'PushDate', t: 'date' },
      { n: 'OutputDirectory', t: 'folder', emit: 'Output', help: 'Download folder.' },
      { n: 'Filename', t: 'str', ph: '2024110507_7.csv' }
    ] },
  { id: 'Get-DatasetStatus', group: 'Analytics',
    synopsis: 'Shows the processing status of a dataset type for a date.',
    params: [
      { n: 'Type', t: 'enum', v: ['roomoccupancy', 'peoplecount', 'badgeswipe'] },
      { n: 'PushDate', t: 'date' }
    ] },

  /* ── Maps ── */
  { id: 'Import-MapCorrelations', group: 'Maps',
    synopsis: 'Two-step correlation of an IMDF map. Run 1 extracts features to mapfeatures.csv. You edit that file to match your buildings, floors and rooms, then run 2 writes the correlations back into the zip.',
    notes: ['Output files are written to the current folder, which is your toolbox output folder. The Map correlation recipe works in the zip\'s own folder instead.'],
    params: [
      { n: 'MapFilePath', t: 'file', req: true, ext: 'zip', help: 'The IMDF .zip.' },
      { n: 'CorrelationsFilePath', t: 'file', ext: 'csv', help: 'Leave empty for run 1. For run 2, pick your edited mapfeatures.csv.' }
    ] },
  { id: 'New-Map', group: 'Maps', after: 'index',
    synopsis: 'Uploads a correlated, georeferenced IMDF floor plan for one building.',
    notes: ['Buildings and floors must already exist and the IMDF must be correlated. Maps can take up to an hour to appear.'],
    params: [
      { n: 'BuildingId', t: 'place', req: true, pick: { types: ['Building'], value: 'id' } },
      { n: 'FilePath', t: 'file', req: true, ext: 'zip' }
    ] },
  { id: 'Remove-Map', group: 'Maps', danger: 'This removes every floor plan for the building and all its floors.', after: 'index',
    synopsis: 'Removes all floor plans for a building.',
    params: [ { n: 'BuildingId', t: 'place', req: true, pick: { types: ['Building'], value: 'id' } } ] },

  /* ── Devices & sensors ── */
  { id: 'Get-PlaceDevice', group: 'Devices & sensors',
    synopsis: 'Gets registered place devices.',
    params: [
      { n: 'Id', t: 'device' },
      { n: 'Top', t: 'int', ph: '100' },
      { n: 'Filter', t: 'str', ph: "Tags/Any(x: cast(x, 'String') eq 'BuildingA')", help: 'OData filter.' }
    ] },
  { id: 'New-PlaceDevice', group: 'Devices & sensors',
    synopsis: 'Registers a device and its sensors in Places.',
    params: [
      { n: 'DeviceId', t: 'str', req: true, ph: 'contoso_9D6816', help: 'Your own identifier for the device.' },
      { n: 'Manufacturer', t: 'str', req: true },
      { n: 'Sensors', t: 'sensors', req: true },
      { n: 'DisplayName', t: 'str' },
      { n: 'Description', t: 'str' },
      { n: 'PlaceId', t: 'place', pick: { types: ['Building', 'Floor', 'Section', 'Desk', 'Room', 'Space'], value: 'id' } },
      { n: 'MACAddress', t: 'str', ph: '00:0A:95:9D:68:16' },
      { n: 'IPV4Address', t: 'str' },
      { n: 'IPV6Address', t: 'str' },
      { n: 'Tags', t: 'str' }
    ] },
  { id: 'Set-PlaceDevice', group: 'Devices & sensors', prefill: 'device',
    danger: 'Set-PlaceDevice overwrites every property. Anything you leave blank is cleared.',
    synopsis: 'Replaces every property of an existing place device.',
    notes: ['Pick the device and choose Load current values, then change only what you need.'],
    params: [
      { n: 'Id', t: 'device', req: true, help: 'The Places device GUID (not your DeviceId).' },
      { n: 'DeviceId', t: 'str', req: true },
      { n: 'Manufacturer', t: 'str', req: true },
      { n: 'Sensors', t: 'sensors', req: true },
      { n: 'DisplayName', t: 'str' },
      { n: 'Description', t: 'str' },
      { n: 'PlaceId', t: 'place', pick: { types: ['Building', 'Floor', 'Section', 'Desk', 'Room', 'Space'], value: 'id' } },
      { n: 'MACAddress', t: 'str' },
      { n: 'IPV4Address', t: 'str' },
      { n: 'IPV6Address', t: 'str' },
      { n: 'Tags', t: 'str' }
    ] },
  { id: 'Remove-PlaceDevice', group: 'Devices & sensors', danger: 'This deletes the device registration.',
    synopsis: 'Deletes a place device.',
    params: [ { n: 'Id', t: 'device', req: true } ] }
];

var DRY = 'Dry run first: every row is checked against your live hierarchy and nothing is changed.';

var RECIPES = [
  /* ── Bulk create ── */
  { id: 'hierarchy', group: 'Bulk create', title: 'Whole site from one CSV', fn: 'Import-TbxPlaceHierarchy', requires: 'places', dry: true, after: 'index', template: 'PlaceHierarchy.csv',
    synopsis: 'Creates buildings, floors, sections, rooms, workspaces and desks from one CSV. Rows are processed parents first, so one file can build a whole site.',
    columns: 'PlaceName, Type, Mailbox, ParentBuildingName, ParentFloorName, ParentSectionName, BuildingDescription, BuildingCountryCode, BuildingState, BuildingCity, BuildingStreet, BuildingPostalCode, RoomCapacity',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'desks', group: 'Bulk create', title: 'Desks from CSV', fn: 'New-TbxDesksFromCsv', requires: 'places', dry: true, after: 'index', template: 'NewDesks.csv',
    synopsis: 'Creates desks in existing sections. Each row can set its own mode: Reservable, Drop-in, Assigned (with User), New or Maintenance. New and Maintenance create the desk as Unavailable.',
    columns: 'DeskName, Mailbox, BuildingName, FloorName, SectionName, Mode (optional), User (for Assigned)',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' },
              { n: 'DefaultMode', t: 'enum', v: ['Reservable', 'Drop-in', 'New', 'Maintenance'], def: 'Reservable', help: 'Used for rows with no Mode.' } ] },
  { id: 'deskpools', group: 'Bulk create', title: 'Desk pools from CSV', fn: 'New-TbxDeskPoolsFromCsv', requires: 'places', dry: true, after: 'index', template: 'NewDeskPools.csv',
    synopsis: 'Creates reservable desk pools (Workspace places) in existing sections.',
    columns: 'DeskPoolName, Capacity, BuildingName, FloorName, SectionName, Mailbox (optional)',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'rooms', group: 'Bulk create', title: 'Rooms from CSV', fn: 'New-TbxRoomsFromCsv', requires: 'places', dry: true, after: 'index', template: 'NewRooms.csv',
    synopsis: 'Creates rooms on existing floors, linking or creating each mailbox.',
    columns: 'RoomName, Mailbox, Capacity, BuildingName, FloorName',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'children', group: 'Bulk create', title: 'Many places under one parent', fn: 'New-TbxPlacesUnderParent', requires: 'places', dry: true, after: 'index', setParam: 'Type', sets: ['Building', 'Floor', 'Section', 'Room', 'Workspace', 'Desk'],
    synopsis: 'Paste a list of names and create them all under one parent: floors in a building, sections on a floor, desks in a section, and so on.',
    params: [
      { n: 'ParentId', t: 'place', sets: ['Floor', 'Section', 'Room', 'Workspace', 'Desk'], req: true, pick: { bySet: { Floor: ['Building'], Section: ['Floor'], Room: ['Floor', 'Section'], Workspace: ['Section'], Desk: ['Section'] }, value: 'id' } },
      { n: 'Name', t: 'lines', req: true, ph: 'Desk 001\nDesk 002\nDesk 003', help: 'One name per line.' },
      { n: 'DeskMode', t: 'enum', sets: ['Desk'], v: ['Reservable', 'Drop-in', 'New', 'Maintenance'], def: 'Reservable' }
    ] },

  /* ── Bulk update ── */
  { id: 'existingrooms', group: 'Bulk update', title: 'Link existing rooms', fn: 'Set-TbxExistingRoomsFromCsv', requires: 'places', dry: true, after: 'index', template: 'ExistingRooms.csv',
    synopsis: 'Puts existing room mailboxes onto floors in the hierarchy, and optionally sets capacity and display name.',
    columns: 'RoomName (optional), Mailbox, BuildingName, FloorName, Capacity (optional)',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'desklocation', group: 'Bulk update', title: 'Move desks to sections', fn: 'Set-TbxDeskLocationFromCsv', requires: 'places', dry: true, after: 'index', template: 'DeskLocations.csv',
    synopsis: 'Moves existing desks into a section and optionally links a mailbox.',
    columns: 'PlaceName, Mailbox (optional), BuildingName, FloorName, SectionName',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'deskmodes', group: 'Bulk update', title: 'Desk modes', fn: 'Set-TbxDeskModesFromCsv', requires: 'places', dry: true, after: 'index', template: 'DeskModes.csv',
    synopsis: 'Sets each desk to Reservable, Drop-in, Assigned (to a user), New or Maintenance.',
    columns: 'DeskName, Mode, User (for Assigned)',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'tags', group: 'Bulk update', title: 'Tags', fn: 'Set-TbxTagsFromCsv', requires: 'places', dry: true, template: 'PlaceTags.csv',
    synopsis: 'Replaces the tags on desks, rooms and workspaces. Blank tag cells are ignored.',
    columns: 'PlaceName, Tag1 … Tag10',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'buildingmeta', group: 'Bulk update', title: 'Building addresses', fn: 'Set-TbxBuildingMetadataFromCsv', requires: 'places', dry: true, template: 'BuildingMetadata.csv',
    synopsis: 'Sets street, city, state, postcode, country and coordinates on buildings. Blank cells are left unchanged.',
    columns: 'BuildingName, Street, City, State, PostalCode, CountryOrRegion, Latitude, Longitude',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },

  /* ── Reports ── */
  { id: 'deskreport', group: 'Reports', title: 'Desk status report', fn: 'Get-TbxDeskStatusReport', requires: 'places',
    synopsis: 'Every desk with its building, floor, section and mode (including unavailable reasons and assigned people). Saved as CSV and as a filterable Watts365-styled HTML page.',
    params: [ { n: 'OpenReport', t: 'switch', def: true, help: 'Open the HTML report when finished.' } ] },
  { id: 'placeexport', group: 'Reports', title: 'Place data export', fn: 'Export-TbxPlaceData', requires: 'places',
    synopsis: 'Exports every place beneath one building, or every building, to CSV. Useful as a backup and for map correlation.',
    params: [ { n: 'BuildingId', t: 'place', pick: { types: ['Building'], value: 'id' }, help: 'Leave empty to export all buildings.' } ] },
  { id: 'licence', group: 'Reports', title: 'Desk licence check', fn: 'Test-TbxDeskLicensing', requires: 'graph',
    synopsis: 'Checks every Reservable and Drop-in desk mailbox for a shared-space licence and saves a compliance CSV.',
    notes: ['Needs Microsoft Graph with User.Read.All, Directory.Read.All and Organization.Read.All.'],
    params: [] },

  /* ── Maps ── */
  { id: 'mapcorrelate', group: 'Maps', title: 'Map correlation (steps 1 and 2)', fn: 'Invoke-TbxMapCorrelation', requires: 'places',
    synopsis: 'Runs Import-MapCorrelations in the IMDF zip\'s own folder. Step 1: pick only the zip to get mapfeatures.csv. Step 2: pick the zip and your edited CSV.',
    params: [ { n: 'MapFilePath', t: 'file', req: true, ext: 'zip' }, { n: 'CorrelationsFilePath', t: 'file', ext: 'csv' } ] },
  { id: 'mapupload', group: 'Maps', title: 'Upload map (replace)', fn: 'Publish-TbxMap', requires: 'places', after: 'index',
    synopsis: 'Uploads a correlated IMDF zip to a building, optionally removing the existing map first.',
    params: [ { n: 'BuildingId', t: 'place', req: true, pick: { types: ['Building'], value: 'id' } },
              { n: 'FilePath', t: 'file', req: true, ext: 'zip' },
              { n: 'ReplaceExisting', t: 'switch', help: 'If the building already has a map, remove it first.' } ] },

  /* ── Exchange calendar ── */
  { id: 'autorelease', group: 'Exchange', title: 'Auto-release', fn: 'Set-TbxAutoReleaseFromCsv', requires: 'exchange', dry: true, template: 'AutoRelease.csv',
    synopsis: 'Turns on auto-release for rooms and desks with Set-CalendarProcessing, with separate check-in and booking-window settings for each.',
    columns: 'ID (mailbox), Type (Room or Desk)',
    params: [
      { n: 'Path', t: 'file', req: true, ext: 'csv' },
      { n: 'RoomClaimMinutes', t: 'int', def: '15', help: 'Rooms: minutes to check in before release.' },
      { n: 'RoomBookingWindowDays', t: 'int', def: '365' },
      { n: 'DeskClaimMinutes', t: 'int', def: '60' },
      { n: 'DeskBookingWindowDays', t: 'int', def: '7' },
      { n: 'DeskAllowRecurring', t: 'bool', def: '$false' }
    ] },
  { id: 'bookin', group: 'Exchange', title: 'Restrict booking to a group', fn: 'Set-TbxBookInPolicyFromCsv', requires: 'exchange', dry: true, template: 'BookInPolicy.csv',
    synopsis: 'Only members of a group can book each space (AutoAccept, BookInPolicy = group, AllBookInPolicy off).',
    columns: 'SpaceID, GroupEmail',
    params: [ { n: 'Path', t: 'file', req: true, ext: 'csv' } ] },
  { id: 'roomlist', group: 'Exchange', title: 'New room list', fn: 'New-TbxRoomList', requires: 'exchange', dry: true,
    synopsis: 'Creates an Exchange room list and adds rooms to it. Room lists drive Initialize-Places building suggestions.',
    params: [ { n: 'Name', t: 'str', req: true }, { n: 'PrimarySmtpAddress', t: 'str' }, { n: 'Members', t: 'lines', ph: 'room1@contoso.com\nroom2@contoso.com', help: 'One room mailbox per line.' } ] },

  /* ── Turn off Places ── */
  { id: 'turnoff1', group: 'Turn off Places', title: 'Step 1: turn off features', raw: true, requires: 'places', after: 'status',
    danger: 'This turns off the Places web app and buildings for everyone in your tenant.',
    synopsis: 'Follows Microsoft\'s "How to turn off Microsoft Places", step 1: turns off the Places web app and buildings for all users.',
    build: function () { return "Set-PlacesSettings -EnablePlacesWebApp 'Default:false'\nSet-PlacesSettings -EnableBuildings 'Default:false'"; },
    params: [] },
  { id: 'turnoff2', group: 'Turn off Places', title: 'Step 2: disable Places Enhanced plan', fn: 'Disable-TbxPlacesEnhancedPlan', requires: 'graph', dry: true,
    synopsis: 'Disables the Places Enhanced service plan (f8566154-2a62-48cb-a0ab-d4d25be26e51) on each user\'s licences and keeps their other disabled plans.',
    notes: ['Needs Microsoft Graph with User.ReadWrite.All and Application.Read.All.', 'Assigning a Teams Premium licence later turns the plan back on.'],
    graphScopes: ['User.ReadWrite.All', 'Application.Read.All'],
    params: [ { n: 'UserPrincipalName', t: 'lines', req: true, ph: 'alex@contoso.com\nsam@contoso.com', help: 'One UPN per line.' } ] }
];

var TEMPLATES = {
  'PlaceHierarchy.csv': 'Whole site', 'NewDesks.csv': 'Desks', 'NewDeskPools.csv': 'Desk pools', 'NewRooms.csv': 'Rooms',
  'ExistingRooms.csv': 'Existing rooms', 'DeskLocations.csv': 'Desk locations', 'DeskModes.csv': 'Desk modes', 'PlaceTags.csv': 'Tags',
  'BuildingMetadata.csv': 'Building addresses', 'AutoRelease.csv': 'Auto-release', 'BookInPolicy.csv': 'Book-in policy',
  'InitializePlacesImport.csv': 'Initialize-Places import'
};

var MODULES = [
  { n: 'MicrosoftPlaces', why: 'All Places cmdlets. Version 2.0.0 or later recommended.', need: true },
  { n: 'ExchangeOnlineManagement', why: 'Auto-release, book-in policy and room list recipes.' },
  { n: 'Microsoft.Graph.Authentication', why: 'Graph sign-in for the licence recipes.' },
  { n: 'Microsoft.Graph.Users', why: 'Licence check, and disabling the Places Enhanced plan.' },
  { n: 'Microsoft.Graph.Identity.DirectoryManagement', why: 'Tenant SKU lookup for the licence check.' }
];
