# AquiferX

## Project Overview
- React 19 + TypeScript 5.8 + Vite 6 groundwater data visualization app
- Data stored in `public/data/{region-folder}/` with per-folder `region.json`
- Vite dev server middleware provides API endpoints in `vite.config.ts` (no separate backend)
- Tailwind CSS for styling, Recharts for charts, Leaflet for maps

## Architecture
- **Hub-and-spoke data management**: `components/import/ImportDataHub.tsx` is the entry point, launching sub-wizards for Region, Aquifer, Well, and Measurement imports
- **Data model**: Region has `dataTypes: DataType[]`, measurements use `value` field + `dataType` code
- **Per-folder metadata**: Each region folder has `region.json` with id, name, lengthUnit, singleUnit, dataTypes
- **Data files**: `data_{code}.csv` naming convention (e.g., `data_wte.csv` for water table elevation)
- **CRS reprojection**: proj4 library in `services/reprojection.ts`, auto-detects from GeoJSON `crs` property or shapefile `.prj`
- **USGS API**: `services/usgsApi.ts` for downloading wells and measurements from USGS Water Data API

## Key Files
- `App.tsx` — main component, state management, data type selector
- `types.ts` — DataType, RegionMeta, Region, Measurement, ChartPoint interfaces
- `services/dataLoader.ts` — loads regions via `/api/regions`, measurements from `data_{code}.csv`
- `services/importUtils.ts` — CSV parsing, file processing, point-in-polygon, save/delete API wrappers
- `services/reprojection.ts` — proj4 coordinate reprojection
- `services/usgsApi.ts` — USGS Water Data API integration
- `components/import/` — ImportDataHub, RegionImporter, AquiferImporter, WellImporter, MeasurementImporter, DataTypeEditor, ColumnMapperModal, ConfirmDialog
- `vite.config.ts` — API middleware endpoints (regions, save-data, delete-file, delete-folder)

## Conventions
- Data type codes: lowercase alphanumeric + underscore, max 20 chars; "wte" is the reserved default (water table elevation)
- Single-unit regions: aquifer section dimmed in UI, all data auto-assigned `aquifer_id=0`
- CSV delimiter auto-detection (comma vs tab)
- Date format auto-detection (ISO, US, EU variants)
- Measurement values stored in `value` column (not `wte`)
- Region data lives in `public/data/{region-id}/` with: `region.json`, `region.geojson`, `aquifers.geojson`, `wells.csv`, `data_{code}.csv`

## Commands
- `npm run dev` — start dev server on port 3000
- `npx tsc --noEmit` — type check
- `npx vite build` — production build
