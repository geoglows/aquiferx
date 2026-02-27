# Overhaul of Import Data Utility

Do a comprehensive overhaul of the Import Data utility. Keep the functionality of the current wizard, but reorganize and expand it. The current wizard has the user import a region, then aquifers, then wells, then measurements. It is a one-time linear process and is not conducive to appending or adding new data.

## Architecture

### Hub Layout

When launching Import Data, present a window with four sections:

- Regions
- Aquifers
- Wells
- Measurements

The window should be clean and professional. Each data type is imported independently via its own sub-wizard. It is possible to import a region without adding aquifers, wells, etc. The user can add those at a later time.

Data dependencies: Aquifers are attached to a specific region, wells are attached to specific aquifers, and measurements are associated with wells. Exception: single-unit regions skip the aquifer layer entirely (see [Single-Unit Mode](#single-unit-mode)).

### Component Decomposition

Break the implementation into separate components rather than a single monolithic file:

- `ImportDataHub.tsx` — the main four-panel view with counters and state management
- `RegionImporter.tsx` — region add sub-wizard (create new or import package)
- `AquiferImporter.tsx` — aquifer add sub-wizard with append/replace options
- `WellImporter.tsx` — well add sub-wizard with aquifer assignment and USGS download
- `MeasurementImporter.tsx` — measurement add sub-wizard with multi-type support, depth conversion, and USGS download

### Auto-Save Behavior

Each sub-wizard saves its data automatically when it completes (via the existing `/api/save-data` endpoint). When a sub-wizard finishes and returns to the hub, the data is already persisted. There is no separate "Save" step on the hub. The existing "Download Region" option in the main interface kebab menu is sufficient for downloads.

### Region Data Storage

Each region is fully self-contained in its own folder under `public/data/`. There is no centralized `regions.json` file. Instead, each region folder contains a `region.json` file with all region metadata. See [Directory Structure](#directory-structure) and [Region Discovery](#region-discovery) for details.

---

## Regions

This section includes a list of all current regions and displays a count of the number of regions. One region is highlighted and treated as the active region. If there are existing regions, the region that is active in the main app should be selected as the active region when the Import Data window is launched. The user can select a different region if desired.

When a region is selected, calculate the number of aquifers attached to this region and display that in the aquifers section. Likewise, count the total numbers of wells in the region and display in the Wells section. For the Measurements section, show a per-data-type breakdown of record counts (see [Data Types](#data-types)).

There should be an "Add Region" button. When clicked, offer two options:

### Option 1: Create New Region

Bring up a sub-wizard with the following steps:

1. **Region attributes**: Prompt for the region name, length units (ft/m), and a **"Single unit (no aquifer subdivisions)"** toggle (default: off). This toggle controls whether the region uses aquifer boundaries or treats the entire region as one analysis unit (see [Single-Unit Mode](#single-unit-mode)).
2. **Region boundary**: Prompt for the region GeoJSON/shapefile.

After upload, create the region folder, write `region.json` with the metadata, save `region.geojson`, return to the main Import Data window, and select the new region as the active region. A WTE data type entry is automatically created for the new region (see [Data Types](#data-types)).

When uploading a region file, reproject to WGS84 (EPSG:4326) if necessary (see [Reprojection](#reprojection) section).

### Option 2: Import Region Package

Upload a region package zip file (see [Region Packages](#region-packages)). This populates everything — region metadata, boundary, aquifers, wells, and all measurement data — in one step.

### Editing Region Attributes

The single-unit toggle and other region attributes should be editable on existing regions, with appropriate warnings if changing modes on a region that already has data (see [Single-Unit Mode](#single-unit-mode)).

---

## Aquifers

If there is no active region, or if the active region is in single-unit mode, the aquifers section should be dimmed. In single-unit mode, display "Single unit — no aquifer subdivisions" in a muted/informational style instead of the counter and button.

If there is a region in aquifer mode, the number of aquifers should be listed and there should be an "Add Aquifers" button.

This should launch a sub-wizard with the following options on the first step:

**Upload aquifers file** (default) — This should mimic the current option where the user uploads a GeoJSON/shapefile and then maps the fields.

**Append or replace** — This should be dimmed if there are no existing aquifers. If there are existing aquifers and the user is uploading a file, let the user specify whether the new aquifers will append to or replace the existing aquifers.

- **Append**: Check aquifer ID values during upload. If an aquifer with the same ID already exists, skip it and display a warning in the console output.
- **Replace**: Show a confirmation dialog before proceeding: "Replacing aquifers will also delete all associated wells (N) and measurements (N). Continue?" Then delete the existing `aquifers.geojson`, `wells.csv`, and all `data_*.csv` files for the region before saving the new aquifers.

When uploading an aquifers file, reproject to WGS84 (EPSG:4326) if necessary (see [Reprojection](#reprojection) section).

After uploading, return to the main Import Data page and update the aquifers counter.

---

## Wells

If there is no active region, the Wells section should be dimmed. In aquifer mode, it should also be dimmed if there are no aquifers yet. In single-unit mode, wells are enabled as soon as the region exists (the aquifer layer is skipped). List the number of wells and show an "Add Wells" button.

This should bring up a sub-wizard with the current steps (upload CSV, map fields, interpolate GSE if necessary) plus the following new options:

### Append or Replace

Only visible/enabled if there are already wells.

- **Replace**: Show a confirmation dialog: "Replacing wells will also delete all associated measurements (N across all data types). Continue?" If replacing all wells in the region (single-unit mode, or no aquifer filter selected), delete all `data_*.csv` files in the region. If replacing only the wells in a specific aquifer (i.e., the user selected "Assign to single aquifer" below in aquifer mode), delete only the measurement rows associated with those wells by well ID from each `data_*.csv` file. Then delete the old wells and save the new ones.
- **Append**: Add the new wells, but check each well ID against existing wells. If a well ID already exists, skip it and report a warning.

### Aquifer Assignment

**In single-unit mode**: This entire section is hidden. All wells are automatically assigned `aquifer_id=0`. The aquifer_id field mapping is skipped in the CSV parsing step.

**In aquifer mode**: Three options:

1. **Assign to single aquifer** — The user selects an aquifer from a dropdown of existing aquifers. The aquifer_id field mapping is skipped in the CSV parsing step; all imported wells are assigned the selected aquifer's ID. If there is only one aquifer in the region, this is the only available option and the other two should be dimmed.

2. **Use aquifer_id field in CSV** — Same as the current behavior. The user maps an aquifer_id column during field mapping.

3. **Assign by well location** — Use point-in-polygon testing with the well's lat/lon against the aquifer boundaries. If a well does not fall inside any existing aquifer, report an error with the well ID and skip that well.

### Data Source

Determine whether to show the USGS download option based on the region's bounding box: if the bounding box is completely outside the US, hide the USGS option. Otherwise, show both options.

1. **Upload a CSV** — Same as the current option. Parse fields, interpolate GSE if not provided.

2. **Download from USGS** — Query the USGS Water Data API (see [USGS API Details](#usgs-api-details)) using the `monitoring-locations` collection filtered by bounding box and site type `GW` (groundwater). Keep only the wells that are strictly inside the aquifer boundaries (point-in-polygon test). Extract the required fields: `monitoring_location_number` → `well_id`, `monitoring_location_name` → `well_name`, geometry coordinates → `lat`/`long`, `altitude` → `gse`. If no wells are found, report an error. Show a progress indicator during the download (spinner + count of records fetched so far).

---

## Data Types

The application supports multiple measurement data types per region. WTE (Water Table Elevation) is the primary/default type, but users can define custom types for other parameters like salinity, pH, contaminant concentrations, etc.

### Definition and Storage

Data type definitions are stored in the region's `region.json` file:

```json
{
  "id": "my-region",
  "name": "My Region",
  "lengthUnit": "ft",
  "singleUnit": false,
  "dataTypes": [
    { "code": "wte", "name": "Water Table Elevation", "unit": "ft" },
    { "code": "salinity", "name": "Salinity", "unit": "mg/L" },
    { "code": "tce", "name": "Trichloroethylene", "unit": "PPM" },
    { "code": "ph", "name": "pH", "unit": "" }
  ]
}
```

**Rules:**
- The WTE entry is always present and auto-created when a region is created. Its unit mirrors the region's `lengthUnit` (ft or m). The WTE entry cannot be deleted.
- Custom types can be added and removed by the user.
- **Code format**: Lowercase, alphanumeric and underscores only, max 20 characters. Must be unique within the region. Validate on creation.
- Each data type is stored in a separate file: `data_{code}.csv` (e.g., `data_wte.csv`, `data_salinity.csv`, `data_ph.csv`).

### File Format

All `data_{code}.csv` files share a uniform schema:

```
well_id,aquifer_id,date,value
WELL-001,3,2024-01-15,4523.7
WELL-001,3,2024-02-15,4521.2
```

The `value` column contains the measurement in the unit specified by the data type definition. This uniform schema means the import and storage logic is the same regardless of type — only the column mapping step and any type-specific conversions (like depth-to-WTE) differ.

### Managing Data Types

In the Import Data hub, add a "Manage Data Types" link or gear icon in the Measurements section header. Clicking it opens a modal dialog for managing the region's data types.

#### Data Type Editor Modal

The modal displays a table/list of all defined data types for the active region:

| Name | Code | Unit | Records | Actions |
|---|---|---|---|---|
| Water Table Elevation | wte | ft | 3,200 | *(locked)* |
| Salinity | salinity | mg/L | 450 | Edit, Delete |
| pH | ph | — | 0 | Edit, Delete |

Below the table, an **"Add Data Type"** button.

**WTE row**: Always present as the first row. The name and code are read-only. The unit is read-only and mirrors the region's `lengthUnit`. The delete button is disabled/hidden. The WTE row cannot be edited or removed.

#### Adding a Data Type

Clicking "Add Data Type" expands an inline form (or small sub-dialog) with three fields:

- **Name** (required): The display name, e.g., "Trichloroethylene". Free text, max 50 characters.
- **Code** (required): The short identifier used in file names, e.g., "tce". Auto-generated from the name as a suggestion (lowercase, spaces → underscores, strip special characters), but editable. Validated: lowercase alphanumeric and underscores only, max 20 characters, must be unique within the region, must not be "wte" (reserved).
- **Unit** (optional): The measurement unit, e.g., "PPM", "mg/L", "μS/cm". Free text, max 20 characters. Can be left blank for dimensionless values (like pH).

**Cross-region suggestions**: Above or alongside the form, show a "From other regions" suggestion list. This is populated by scanning all other regions' `region.json` files and collecting any data types not already defined in the current region (deduplicate by code). Clicking a suggestion auto-fills all three fields. This avoids repetitive data entry when the same parameter (e.g., "Salinity", "mg/L") is used across multiple regions.

A "Save" button adds the entry to `dataTypes` in the region's `region.json`. No `data_{code}.csv` file is created yet — that happens when measurements of this type are first imported.

#### Editing a Data Type

Clicking "Edit" on a custom data type opens the same inline form pre-populated with the current values. The **code field is read-only** after creation (since it's used as a filename). The name and unit can be changed.

- If the **unit** is changed and there are existing measurements, show an informational note: "Changing the unit does not convert existing values. Ensure existing data is consistent with the new unit."
- Save updates the entry in `region.json`.

#### Deleting a Data Type

Clicking "Delete" shows a confirmation dialog:
- If there are existing measurements: "Deleting [Name] will permanently delete N measurements. Continue?"
- If there are no measurements: "Delete the [Name] data type? Continue?"

On confirmation, delete the `data_{code}.csv` file (if it exists) and remove the entry from `dataTypes` in `region.json`.

#### Inline Add During Import

Users can also add a new data type inline during the measurement import sub-wizard (in the data type selection step). An "Add new data type" button opens the same add form described above. After saving, the new type appears in the toggle list and can be selected for the current import.

---

## Measurements

This section should be dimmed if there are no wells in the region (regardless of mode). It should display a per-data-type record count breakdown:

- WTE: 3,200 records
- Salinity: 450 records
- pH: 450 records

If only WTE exists (the common case), just show "WTE: N records." Include an "Add Measurements" button and the "Manage Data Types" link/gear icon described above.

### Data Type Selection

The first step of the measurement sub-wizard is selecting which data types are present in the file being uploaded. Display the region's defined data types as a list of toggles. The user enables each type that has data in their CSV.

- If the user needs a type that doesn't exist yet, provide an "Add new data type" button inline that opens the same add dialog (name, code, unit) without leaving the sub-wizard.
- At least one data type must be toggled on to proceed.

**WTE-specific sub-option**: When WTE is toggled on, show a sub-option: "Values are: **WTE** / **Depth below GSE**". If "Depth below GSE" is selected, the conversion `WTE = GSE - abs(depth)` is applied during import. This sub-option only appears for WTE — it is not relevant to other data types.

### Column Mapping

After file upload and data type selection, the column mapping step shows the standard fields (`well_id`, `date`, and `aquifer_id` if applicable) plus one value column mapping per selected data type:

- **WTE value column**: dropdown to select which CSV column contains WTE data
- **Salinity value column**: dropdown to select which CSV column contains salinity data
- etc.

Auto-match column names where possible: try matching the data type code and name against CSV column headers (case-insensitive). For example, a column named "pH" or "ph" should auto-match the pH data type.

### Append or Replace

Only visible/enabled if there are already measurements for the selected data types. **Append/replace is scoped per data type** — importing new salinity and pH data with "Replace" selected only replaces `data_salinity.csv` and `data_ph.csv`. It does not touch `data_wte.csv` or any other types.

- **Replace**: Show a confirmation dialog: "This will delete existing measurements for: [list of selected types with counts]. Continue?" Delete the relevant `data_{code}.csv` files after the new upload is complete.
- **Append**: Add new records, but check for duplicates by matching on date, well ID, and aquifer ID within each data type. If a match is found, skip the duplicate and report a warning.

### Aquifer Assignment

**In single-unit mode**: This entire section is hidden. All measurements are automatically assigned `aquifer_id=0`. The aquifer_id field mapping is skipped.

**In aquifer mode**: When importing measurements, account for cases where wells in different aquifers may have the same ID. If there is only one aquifer, default to "Unique well IDs" and dim the other options.

1. **Unique well IDs** — The well IDs are globally unique within the region. Match by well ID alone. Look up and store the associated `aquifer_id` in each output file.

2. **Assign to single aquifer** — The user selects an aquifer from the list. Match measurements to wells within that aquifer only. Store the `aquifer_id` in each output file.

3. **Use aquifer_id field** — The measurement CSV has an `aquifer_id` column. Associate first by `aquifer_id`, then by `well_id`. Store the `aquifer_id` in each output file.

**Important**: Every `data_{code}.csv` file must have an `aquifer_id` field (set to `0` for single-unit regions, or the actual aquifer ID for aquifer-mode regions). This enables efficient lookup and deletion of measurements by aquifer. The migration of existing data files is handled separately (see [Existing Data Migration](#existing-data-migration)).

### Data Source

Same bounding-box-based US detection as Wells. If the bounding box is completely outside the US, hide the USGS option.

1. **Upload a CSV** — The standard option. Parse fields, select data types, map columns as described above.

2. **Download from USGS** — This option is only available for WTE data. When selected, skip the data type selection and column mapping steps entirely. Query the USGS Water Data API (see [USGS API Details](#usgs-api-details)) using the `field-measurements` collection filtered by `monitoring_location_id` values matching the current wells and `parameter_code` for depth-to-water (`72019`). Extract: `time` → `date`, `value` → water level, `monitoring_location_id` → `well_id`. Convert depth-to-water values to WTE using the well's GSE (`WTE = GSE - abs(value)`). If no matching measurements are found, report an error. Show a progress indicator during the download. Save results to `data_wte.csv`.

### Multi-Type Import Flow

When a user uploads a CSV containing multiple data types, the import produces multiple output files. For example, a CSV with WTE and salinity columns produces both `data_wte.csv` and `data_salinity.csv`. The split happens after column mapping:

- For each row in the source CSV, extract the `well_id`, `aquifer_id`, and `date` fields (shared across all types).
- For each selected data type, read the mapped value column. If the value is empty/null for that row, skip it for that type.
- Write each type's data to its own `data_{code}.csv` file.

After importing, return to the Import Data page and update the per-type measurement counters.

---

## Single-Unit Mode

Single-unit mode is for regions where the user wants to analyze the entire region as one unit without subdividing into aquifers. This is a region-level attribute, not an import option.

### Data Model

The `singleUnit` boolean field is stored in the region's `region.json` file. Default: `false`.

```json
{
  "id": "my-region",
  "name": "My Region",
  "lengthUnit": "ft",
  "singleUnit": false,
  "dataTypes": [
    { "code": "wte", "name": "Water Table Elevation", "unit": "ft" }
  ]
}
```

When `singleUnit` is `true`:
- A hidden `aquifers.geojson` is auto-generated behind the scenes by copying the region geometry, with `aquifer_id=0` and `aquifer_name` set to the region name. This file is never exposed in the UI but keeps internal code (bounding box calculations, point-in-polygon checks, etc.) working without special-casing.
- All wells and measurements use `aquifer_id=0`.

### Import Data Hub Behavior

When the active region is in single-unit mode:
- **Aquifers section**: Dimmed/muted. Displays "Single unit — no aquifer subdivisions" instead of a counter and button.
- **Wells section**: Enabled as soon as the region exists (no need to wait for aquifers). All aquifer assignment options are hidden; wells are auto-assigned `aquifer_id=0`.
- **Measurements section**: All aquifer assignment options are hidden; measurements are auto-assigned `aquifer_id=0`.

### Main App UI Behavior

When a single-unit region is selected in the main app:
- The left panel should **not** show an aquifer sub-list under the region. Clicking the region expands directly to the wells list.
- All other functionality (charts, maps, data editor, etc.) works the same, just without the aquifer grouping layer.

### Switching Modes on Existing Regions

The single-unit toggle should be editable on existing regions. Changing modes has consequences:

- **Aquifer mode → Single-unit**: Warn: "Switching to single-unit mode will remove all aquifer boundaries. Wells and measurements will be reassigned to aquifer_id=0. Continue?" If confirmed, delete `aquifers.geojson`, regenerate it from the region boundary with `aquifer_id=0`, and update all `aquifer_id` values in `wells.csv` and all `data_*.csv` files to `0`. Update `region.json`.

- **Single-unit → Aquifer mode**: Warn: "Switching to aquifer mode requires uploading aquifer boundaries. Existing wells will need to be reassigned to aquifers. Continue?" If confirmed, delete the auto-generated `aquifers.geojson`. The aquifers section becomes active and the user must upload aquifer boundaries. Wells and measurements retain `aquifer_id=0` until reassigned (the wells section should prompt for reassignment). Update `region.json`.

### Distinction from Single-Aquifer Regions

A single-unit region is conceptually different from a region that happens to have one uploaded aquifer. In the latter case, the aquifer may have its own name, its boundary may differ from the region boundary, and it appears in the UI as a normal aquifer. Single-unit mode is specifically for "I don't care about aquifer boundaries."

---

## Region Discovery

There is no centralized `regions.json` file. The app discovers regions by scanning the `public/data/` directory at startup:

1. List all subdirectories in `public/data/`.
2. For each subdirectory, check if a `region.json` file exists.
3. If yes, read it and treat the directory as a region. The directory name serves as the region `id`.
4. If no `region.json` is found, skip the directory.

This means adding a region creates a folder + `region.json`, and deleting a region removes the folder entirely.

---

## Region Packages

A region package is a zip file containing all data for a single region. This enables downloading a complete region and re-uploading it elsewhere (or sharing between users/instances).

### Download

The existing "Download Region" option in the main interface kebab menu should produce a zip file containing all files in the region folder:

```
region.json              (metadata: id, name, lengthUnit, singleUnit, dataTypes)
region.geojson           (boundary)
aquifers.geojson         (if present)
wells.csv                (if present)
data_wte.csv             (if present)
data_salinity.csv        (if present, example custom type)
data_ph.csv              (if present, example custom type)
```

The zip should be flat (no subfolder). The filename should be the region id, e.g., `oregon.zip`.

### Upload (Import Region Package)

In the Import Data hub's Regions section, the "Add Region" flow offers "Import region package" as an alternative to creating a new region manually. The upload flow:

1. User selects a zip file.
2. App reads `region.json` from the zip and extracts the `id` field.
3. **If a region folder with that `id` already exists**: Show a confirmation dialog — "A region named [name] already exists. This will replace it and all its data. This cannot be undone. Continue?"
4. If confirmed (or no conflict): create/overwrite the region folder and extract all files from the zip.
5. Return to the Import Data hub with the imported region selected as active.

### Zip Validation

Before extracting, validate the zip contents:

- `region.json` must exist and contain the required fields: `id`, `name`, `lengthUnit`. If `dataTypes` is missing, auto-create it with the default WTE entry using the `lengthUnit` value. If `singleUnit` is missing, default to `false`.
- `region.geojson` must exist and be valid GeoJSON.
- If `wells.csv` exists but `aquifers.geojson` does not:
  - If `singleUnit` is `true`: auto-generate `aquifers.geojson` from `region.geojson` with `aquifer_id=0`.
  - If `singleUnit` is `false`: report a warning — "Wells found but no aquifer boundaries. Wells may not display correctly until aquifers are uploaded."
- Any `data_*.csv` files should have corresponding entries in `dataTypes`. If a file exists without a matching type definition (e.g., `data_salinity.csv` but no salinity entry in `dataTypes`), auto-add the type with code derived from the filename, a placeholder name (titlecase of the code), and an empty unit. Log a warning.
- Reproject `region.geojson` and `aquifers.geojson` to EPSG:4326 if they are not already in that projection (see [Reprojection](#reprojection)).

---

## Main App UI Changes for Data Types

Supporting multiple data types requires changes to the main application interface beyond the Import Data utility.

### Data Type Selector

Add a data type selector (dropdown or segmented control) in the main app UI. This should be visible when a region with multiple data types is selected. If the region only has WTE, the selector can be hidden or shown as a static label.

The selected data type controls:
- **Time series chart**: When a well is clicked, display the time series for the selected data type. The Y-axis label and unit update dynamically (e.g., "WTE (ft)" vs "Salinity (mg/L)" vs "pH").
- **Min measurements filter**: The filter applies to the selected data type. A well with 100 WTE records but 0 salinity records should be filtered out when viewing salinity.
- **Well list / map coloring**: If wells are color-coded or sized by measurement count, use the count for the selected data type.

### Region Context and Scoping

Data types are defined per-region, so the data type selector changes when the user switches regions. To make this clear:

- **Show the region name alongside the data type selector** — e.g., "Oregon — WTE (ft)" — so it's obvious the selector is scoped to the active region. When the user switches regions, the selector resets to WTE (the default) and the label updates to reflect the new region.
- If the new region has only WTE, the selector hides or becomes a static label. If it has multiple types, the full dropdown appears. The visible change in the selector when switching regions reinforces that data types are region-specific.

### Placement

The data type selector should be placed prominently — near the top of the left panel or near the time series chart — so users understand that it affects what they're viewing. The current data type and region name should be clearly labeled.

### Future Consideration

Dual-axis or overlay charts (e.g., WTE and salinity on the same chart) are a natural extension but should not be implemented in this phase. Keep the UI simple: one data type selected at a time.

---

## Reprojection

The application assumes all spatial data is in WGS84 (EPSG:4326). When a user uploads a GeoJSON or shapefile that uses a different coordinate reference system, reproject it to EPSG:4326 before storing.

**Detection:**
- For shapefiles (`.zip`): read the `.prj` file included in the archive. The `.prj` file contains a WKT definition of the CRS.
- For GeoJSON: check for a `crs` property in the JSON. Note that per the GeoJSON spec (RFC 7946), GeoJSON should always be in WGS84, but older files may include a `crs` field indicating a different projection.

**Library:** Use the `proj4` npm package (`proj4js`). It supports parsing WKT CRS definitions from `.prj` files and transforming coordinates between projections.

**Implementation:**
1. After parsing the uploaded file, check if it has CRS metadata.
2. If CRS is not EPSG:4326/WGS84/CRS84, transform all coordinates using `proj4(sourceCRS, 'EPSG:4326', [x, y])`.
3. Iterate over all features and transform each coordinate in the geometry (handle Point, MultiPoint, LineString, MultiLineString, Polygon, MultiPolygon, GeometryCollection).
4. Remove any non-standard `crs` property from the output GeoJSON.
5. Log a message in the console output: "Reprojected from [source CRS] to WGS84 (EPSG:4326)".

---

## USGS API Details

**Base URL:** `https://api.waterdata.usgs.gov/ogcapi/v0`

**API Key:** Required. Register at `https://api.waterdata.usgs.gov/signup/`. Pass via query parameter `api_key` or header `X-Api-Key`. Store the key in an environment variable or app settings.

**Rate Limits:** The API has rate limits. Use reasonable concurrency (max 3-5 parallel requests). Implement retry with backoff on 429 responses.

### Fetching Wells (Monitoring Locations)

```
GET /collections/monitoring-locations/items?bbox={minLng},{minLat},{maxLng},{maxLat}&site_type_code=GW&limit=10000&f=json
```

**Field mapping:**
| API Field | App Field |
|---|---|
| `monitoring_location_number` | `well_id` |
| `monitoring_location_name` | `well_name` |
| geometry coordinates | `lat`, `long` |
| `altitude` | `gse` (note: altitude is in feet relative to vertical datum) |

**Pagination:** Use `offset` parameter if results exceed `limit`. The response includes a `numberMatched` field indicating total available records.

**Post-processing:** After fetching, filter to only wells whose coordinates fall strictly inside the aquifer boundaries (point-in-polygon). Convert `altitude` units if the region uses meters (divide by 3.28084).

### Fetching Groundwater Levels (Field Measurements)

```
GET /collections/field-measurements/items?monitoring_location_id={siteId}&parameter_code=72019&limit=10000&f=json
```

- `parameter_code=72019` = depth to water level, feet below land surface
- Query per well or batch by multiple `monitoring_location_id` values if the API supports it
- Paginate with `offset` if needed

**Field mapping:**
| API Field | App Field |
|---|---|
| `monitoring_location_id` | `well_id` (strip agency prefix, e.g., "USGS-" prefix) |
| `time` | `date` (parse to YYYY-MM-DD) |
| `value` | depth → convert to WTE via `GSE - abs(value)` |

**Notes:**
- Values from this endpoint are depth-to-water (feet below land surface). Always convert to WTE.
- Convert units if the region uses meters.
- Filter out records with null or empty `value`.
- The `approval_status` field indicates "Provisional" or "Approved" data — consider logging this.
- USGS download is only available for WTE data. Custom data types are upload-only. (The USGS Water Quality Portal at `https://www.waterqualitydata.us/` could be integrated for water quality parameters in a future phase.)

### US Bounding Box Detection

Show the USGS download option unless the region's bounding box is completely outside the US. Use the existing `isInUS()` check logic against the four corners of the bounding box. If at least one corner falls within US boundaries (continental US, Alaska, Hawaii, Puerto Rico, USVI, Guam), show the USGS option.

### Progress UI

For all USGS API calls, show:
- A spinner/progress indicator while fetching
- Count of records fetched so far (update as pages are retrieved)
- Estimated total from `numberMatched` if available
- Error messages if the API returns errors or no data

---

## Directory Structure

Each region is fully self-contained in its own folder:

```
/public/data/
├── oregon/
│   ├── region.json              (metadata: id, name, lengthUnit, singleUnit, dataTypes)
│   ├── region.geojson           (boundary polygon)
│   ├── aquifers.geojson         (aquifer boundaries)
│   ├── wells.csv                (well locations)
│   ├── data_wte.csv             (water table elevation measurements)
│   ├── data_salinity.csv        (example custom type)
│   └── data_ph.csv              (example custom type)
├── volta-basin/
│   ├── region.json
│   ├── region.geojson
│   ├── aquifers.geojson
│   ├── wells.csv
│   └── data_wte.csv
└── ...
```

There is no top-level `regions.json`. Each region's `region.json` contains all metadata previously stored in that centralized file. The set of `data_*.csv` files present in a region folder corresponds to the data types that have been imported. The `dataTypes` array in `region.json` defines all available types (including those with no data yet). To check which types have data, glob for `data_*.csv` files or check file existence.

---

## Existing Data Migration

The new approach introduces several changes to existing data files:

1. The centralized `regions.json` is replaced by per-folder `region.json` files.
2. Each `region.json` includes a `dataTypes` array and a `singleUnit` field.
3. The file `water_levels.csv` is renamed to `data_wte.csv`.
4. Every measurement file must include an `aquifer_id` column.

**Create a separate migration script** (`scripts/migrate_data_files.ts` or similar) that:

1. Reads the existing `regions.json` to get all region entries.
2. For each region:
   a. Creates a `region.json` file in the region's folder containing: `id` (folder name), `name`, `lengthUnit` (from the old entry), `singleUnit: false`, and `dataTypes: [{ "code": "wte", "name": "Water Table Elevation", "unit": "<lengthUnit>" }]`.
   b. Reads `wells.csv` to build a `well_id → aquifer_id` lookup map.
   c. Reads `water_levels.csv`, adds an `aquifer_id` column by looking up each row's `well_id`, and writes the result as `data_wte.csv`.
   d. Deletes the old `water_levels.csv`.
3. Deletes the old top-level `regions.json`.
4. Logs which regions were migrated and how many rows were modified.

Save detailed instructions for this migration in `prompt_aquifer_id.md`.

---

## Confirmation Dialogs for Destructive Operations

Any operation that deletes existing data must show a confirmation dialog before proceeding. Specifically:

- **Import region package (overwrite)**: "A region named [name] already exists. This will replace it and all its data. This cannot be undone. Continue?"
- **Replace aquifers**: "Replacing aquifers will delete all existing wells (N) and measurements (N across all data types) in this region. Continue?"
- **Replace wells (all)**: "Replacing wells will delete all associated measurements (N across all data types) in this region. Continue?"
- **Replace wells (single aquifer)**: "Replacing wells in [aquifer name] will delete N wells and their associated measurements across all data types. Continue?"
- **Replace measurements**: "This will delete existing measurements for: [list of selected types with counts]. Continue?" (Scoped to the data types being imported.)
- **Delete data type**: "Deleting the [name] data type will also delete N associated measurements. Continue?"
- **Switch to single-unit mode**: "Switching to single-unit mode will remove all aquifer boundaries. Wells and measurements will be reassigned to aquifer_id=0. Continue?"
- **Switch to aquifer mode**: "Switching to aquifer mode requires uploading aquifer boundaries. Existing wells will need to be reassigned to aquifers. Continue?"

Use a modal dialog with "Cancel" and "Continue" buttons. "Cancel" returns to the sub-wizard options without making changes.
