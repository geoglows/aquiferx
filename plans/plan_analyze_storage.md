# Analyze Aquifer Storage Feature

## Overview

Add an "Analyze Storage" button next to the existing "Analyze Trends" button in the header toolbar. This feature analyzes storage change in a selected aquifer over time and produces:

1. A time-varying raster of interpolated water levels in the aquifer
2. A time series of aquifer storage change

The button is only visible when an aquifer is selected (same pattern as the existing Analyze Trends button in `App.tsx:715-727`).

---

## Phase 1: UI — Options Dialog & Data Density Chart

### Analyze Storage Button

- Rendered in the header bar next to "Analyze Trends" in `App.tsx`
- Only visible when `selectedAquifer` is non-null
- Styled similarly to Analyze Trends (use a distinct color, e.g., teal/emerald)
- Clicking opens a modal/panel with the options below

### Data Preview Panel (Two Charts)

When the dialog opens, analyze all WTE measurements for wells in the selected aquifer and display two stacked charts that share the same X-axis (time):

**Upper panel — PCHIP Time Series Preview**:
- Run PCHIP interpolation for each well in the aquifer (using `utils/interpolation.ts`)
- Plot each well as a thin colored line with small dots at actual measurement points
- One color per well (cycle through a palette)
- Y-axis: water level (in region length units)
- This gives the user a visual sense of the temporal coverage and data quality
- No legend needed (too many wells); tooltip on hover showing well name is sufficient

**Lower panel — Data Density Histogram**:
- Bar chart showing the **number of wells with at least one measurement** per 6-month bin
- Bins: Jan–Jun and Jul–Dec of each year (labeled as "2005 H1", "2005 H2", etc.)
- Y-axis: well count
- Draw a horizontal dashed line at the 10-well threshold to visualize the cutoff
- Bars below the threshold could be styled with reduced opacity or a different color

Both panels use Recharts. The X-axis range spans the full extent of all measurement data.

**Default date logic**:
- **Start date**: The earliest January 1 of a 6-month bin where >= 10 wells have data
- **End date**: The latest January 1 (or July 1) after the last 6-month bin where >= 10 wells have data
- The user can adjust both dates manually
- The selected date range could be shown as a shaded region or vertical markers on both charts

### Options

| Option | Description | Default |
|--------|-------------|---------|
| **Start Date** | Beginning of analysis period | Auto from data density (>= 10 wells) |
| **End Date** | End of analysis period | Auto from data density (>= 10 wells) |
| **Resolution** | Number of pixels in X direction for the raster grid | 100 |
| **Storage Coefficient** | Dimensionless, used in volume calculation | 0.15 |
| **Interval** | Time step: 3 months, 6 months, or 1 year | 1 year |
| **Volume Units** | Depends on region `lengthUnit` (see below) | acre-ft or m^3 |
| **Title** | User-provided name for this analysis | (required) |

**Interval dates**:
- 1 year: Jan 1 of each year
- 6 months: Jan 1, Jul 1
- 3 months: Jan 1, Apr 1, Jul 1, Oct 1

**Volume units** (based on `selectedRegion.lengthUnit`):
- If `ft`: acre-ft (default), ft^3
- If `m`: m^3 (default), MCM, km^3

**Title → code**: Slugify the title (e.g., "My Analysis 2024" → `my_analysis_2024`). Check for name conflicts with existing analysis files in the region folder. The analysis will be saved as `storage_{code}.json`.

---

## Phase 2: Computation — Temporal & Spatial Interpolation

### Step 1: Build the Raster Grid

Create a regular grid at the selected resolution:
- Compute the bounding box of the aquifer geometry (`selectedAquifer.bounds`)
- Set X pixel count = resolution (e.g., 100)
- Compute cell size: `dx = (maxLng - minLng) / resolution`
- Set `dy = dx` (square cells)
- Y pixel count = `ceil((maxLat - minLat) / dy)`
- Grid cell centers: `lng_i = minLng + (i + 0.5) * dx`, `lat_j = minLat + (j + 0.5) * dy`
- Mark each cell as inside/outside the aquifer boundary using point-in-polygon test (reuse `isPointInGeoJSON` from `MapView.tsx`)

### Step 2: Temporal Interpolation (PCHIP)

For each well in the aquifer with WTE measurements:
- Collect all measurements, sort by date
- Use the existing `interpolatePCHIP()` from `utils/interpolation.ts`
- Input `x`: measurement dates as timestamps (ms)
- Input `y`: measurement values
- Input `targetX`: the analysis interval dates as timestamps
- **Only interpolate** — do not extrapolate. A well only contributes a value at a given interval date if that date falls within the well's measurement date range.

### Step 3: Spatial Interpolation (Ordinary Kriging)

For each interval date, take the extracted well values and interpolate to the raster grid using **Ordinary Kriging** based on the algorithm in `gwdm_aquifermapping.ipynb`.

**Variogram model**: Stable variogram with heuristic parameter estimation:
- `sill` = variance of the well values at this timestep
- `range` = 1/4 of the spatial diagonal of the aquifer bounding box
- `nugget` = standard deviation of the well values at this timestep

**Kriging algorithm** (reimplement in TypeScript, ~100-150 lines):
1. Build the (N+1) x (N+1) kriging matrix where N = number of wells with values at this timestep
   - Entry (i,j) = variogram value at distance between well i and well j
   - Last row/column = 1s (Lagrange multiplier), corner = 0
2. Solve the linear system for each grid cell:
   - Right-hand side = variogram values at distances from the grid cell to each well, plus 1
   - Solve for weights using matrix inversion or LU decomposition
3. Interpolated value at grid cell = weighted sum of well values
4. Set cells outside the aquifer boundary to null/NaN

**Distance calculation**: Use Haversine formula for geographic coordinates (lat/lng), or convert to a local projected coordinate system for the distance matrix.

**New file**: `services/kriging.ts` — contains the kriging implementation.

### Step 4: Storage Volume Calculation

For each consecutive pair of rasters (timestep i and i-1):

```
volume_change = sum over all clipped cells of: (cell_value_i - cell_value_{i-1}) * cell_area * Sc
```

Where:
- `cell_area` = area of one grid cell in appropriate length units (use Haversine-based area calculation since cells are in lat/lng)
- `Sc` = storage coefficient (user input)
- Only sum cells that are inside the aquifer boundary AND have valid values at both timesteps

**Unit conversions**:
- Cell area computed in ft^2 or m^2 (based on region `lengthUnit`)
- Convert to selected volume unit:
  - acre-ft: volume_ft3 / 43560
  - ft^3: direct
  - m^3: direct
  - MCM: volume_m3 / 1,000,000
  - km^3: volume_m3 / 1,000,000,000

**Storage time series**: Each entry has:
- `date`: midpoint between the two raster dates
- `value`: cumulative storage change from first interval (sum of volume changes)

---

## Phase 3: File Storage — JSON Format

All analysis data stored in a single JSON file: `storage_{code}.json` in the region folder (`public/data/{region-id}/`).

### JSON Structure

```json
{
  "version": 1,
  "title": "My Analysis 2024",
  "code": "my_analysis_2024",
  "aquiferId": "3",
  "aquiferName": "Willamette Lowland",
  "regionId": "oregon",
  "params": {
    "startDate": "2000-01-01",
    "endDate": "2024-01-01",
    "resolution": 100,
    "storageCoefficient": 0.15,
    "interval": "1year",
    "volumeUnit": "acre-ft"
  },
  "grid": {
    "minLng": -123.5,
    "minLat": 44.0,
    "dx": 0.005,
    "dy": 0.005,
    "nx": 100,
    "ny": 80,
    "mask": [0, 0, 1, 1, 1, ...],
  },
  "frames": [
    {
      "date": "2000-01-01",
      "values": [null, null, 125.3, 126.1, ...]
    },
    {
      "date": "2001-01-01",
      "values": [null, null, 124.8, 125.5, ...]
    }
  ],
  "storageSeries": [
    { "date": "2000-07-02", "value": 0 },
    { "date": "2001-07-02", "value": -1250.5 }
  ],
  "createdAt": "2026-02-23T10:30:00Z"
}
```

**Notes**:
- `grid.mask`: Flattened row-major boolean array (1 = inside aquifer, 0 = outside). Cells outside the aquifer have `null` in frame values.
- `frames[].values`: Flattened row-major array of interpolated water levels. Length = `nx * ny`. Null for masked-out cells.
- `storageSeries`: Cumulative storage change from the first interval, in the selected volume units.
- One JSON file per analysis. Multiple analyses per aquifer are supported (different titles/codes).

### API Endpoint

Add a new endpoint in `vite.config.ts` or reuse the existing `/api/save-data` endpoint to write the JSON file to the region folder.

---

## Phase 4: Display — Map Overlay & Animation

### Raster Overlay on Map

- Render the current frame as a **Leaflet ImageOverlay** using a dynamically generated canvas
- The canvas renders each grid cell as a colored rectangle using the **Viridis** color ramp
- Bounds: `[[minLat, minLng], [maxLat, maxLng]]` from the grid metadata
- Cells with null values (outside aquifer) are transparent
- Color scale: map min/max across ALL frames to maintain consistent coloring during animation

### Animation Controls

Render a control bar (below the map or as an overlay) with:
- **Play / Pause** button
- **Scrubber**: A slider/handle to manually drag through frames
- **Date display**: Show the date of the currently displayed frame
- **Speed control**: Adjust animation speed (optional, could be a simple fast/slow toggle)

### Storage Time Series in Chart

- When a storage analysis is loaded, display the `storageSeries` in the `TimeSeriesChart` component (or a dedicated chart panel below it)
- X-axis: dates, Y-axis: cumulative storage change in selected volume units
- **Sync with animation**: As the raster animates, show a **vertical dashed red line** on the chart at the date of the currently displayed raster frame
- The red line moves in sync with the animation/scrubber

### Multiple Analyses

- When an aquifer has multiple storage analyses, provide a **dropdown selector** to switch between them
- Display metadata for the selected analysis (title, parameters, creation date) in a small info panel
- Switching analyses updates both the map overlay and the storage chart

### Loading Existing Analyses

- On aquifer selection, scan the region folder for `storage_*.json` files matching the aquifer ID
- Load the most recent analysis automatically (or show a prompt to select)
- The user can also create a new analysis via the Analyze Storage button

---

## Implementation Plan

### Phase 1: UI (Button, Dialog, Data Density Chart)
**Files to modify**: `App.tsx`, new component `components/StorageAnalysisDialog.tsx`

- Add "Analyze Storage" button in App.tsx header (next to Analyze Trends)
- Create StorageAnalysisDialog component with:
  - Data density bar chart (Recharts BarChart)
  - Date range pickers with auto-defaults
  - All option inputs (resolution, storage coeff, interval, units, title)
  - Name conflict validation
  - Run button

### Phase 2: Computation Engine
**New files**: `services/kriging.ts`, `services/storageAnalysis.ts`

- `services/kriging.ts`: Ordinary Kriging implementation (variogram, matrix solve, interpolation)
- `services/storageAnalysis.ts`: Orchestrator that:
  1. Builds the raster grid
  2. Runs PCHIP per well (using existing `utils/interpolation.ts`)
  3. Runs kriging per timestep
  4. Clips to aquifer boundary
  5. Computes storage volumes
  6. Assembles the JSON output
- Progress callback for UI feedback during computation

### Phase 3: Map Visualization & Animation
**Files to modify**: `components/MapView.tsx`, new component `components/RasterAnimationControls.tsx`

- Canvas-based raster rendering with Viridis color ramp
- Leaflet ImageOverlay integration
- Animation controls component (play/pause, scrubber, date display)
- Frame-by-frame rendering from JSON data

### Phase 4: Storage Chart & Integration
**Files to modify**: `components/TimeSeriesChart.tsx` or new `components/StorageChart.tsx`, `App.tsx`

- Storage time series chart with synced red cursor line
- Analysis selector dropdown for multiple analyses per aquifer
- Metadata display panel
- Auto-load existing analyses on aquifer selection
- Save/load via API endpoints in `vite.config.ts`

---

## Codebase References

| What | Where |
|------|-------|
| Analyze Trends button (pattern to follow) | `App.tsx:715-727` |
| Selected aquifer state | `App.tsx:66-67` (`selectedAquifer`) |
| Region length unit | `selectedRegion.lengthUnit` |
| PCHIP interpolation | `utils/interpolation.ts` → `interpolatePCHIP(x, y, targetX)` |
| Time series chart | `components/TimeSeriesChart.tsx` |
| Point-in-polygon | `components/MapView.tsx` → `isPointInGeoJSON()` |
| Aquifer geometry | `Aquifer.geojson` (type in `types.ts`) |
| Well type | `types.ts` → `Well` interface |
| Measurement type | `types.ts` → `Measurement` interface |
| Region data folder | `public/data/{region-id}/` |
| API endpoints | `vite.config.ts` |
| Kriging reference algorithm | `gwdm_aquifermapping.ipynb` "Spatial Interpolation" section |
