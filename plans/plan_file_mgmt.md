# File and Data Management

## Goal

Organize generated/derived data files (raster JSON, etc.) into per-aquifer subfolders within each region, replacing the current flat structure where files like `storage_*.json` sit directly in the region folder.

The analyze storage tool will also be generalized to work on multiple data types (not just wte). That work is described in a separate plan.

## Folder Structure

Generated files go in a subfolder per aquifer, located under the region folder:

```
public/data/{region-id}/{slugified-aquifer-name}/
```

The aquifer name is slugified (lowercase, spaces/special chars replaced with hyphens) to keep folder names filesystem-safe.

For single-unit regions (where all data is assigned `aquifer_id=0`), the same pattern applies — the subfolder uses the slugified aquifer name even if it matches the region name. This keeps the rule uniform with no special cases.

Example — multi-aquifer region:
```
public/data/jamaica/
  region.json
  region.geojson
  aquifers.geojson
  wells.csv
  data_wte.csv
  liguanea-plains/
    raster_wte_pchip-1.json
    raster_wte_move-avg.json
  clarendon/
    raster_wte_map3.json
```

Example — single-unit region:
```
public/data/edwards/
  region.json
  region.geojson
  wells.csv
  data_wte.csv
  edwards/
    raster_wte_storage-1.json
```

## File Naming Convention

All generated files follow the pattern:

```
{type}_{datatype}_{code}.{ext}
```

- **type**: category of generated file (e.g. `raster`)
- **datatype**: the data type code from region.json (e.g. `wte`, `salt`)
- **code**: user-provided identifier for this particular run/version

Examples:
```
raster_wte_pchip-1.json
raster_salt_map3.json
```

If other generated file types are added in the future, they follow the same pattern:
```
{type}_{datatype}_{code}.*
```

## Code Naming Rules

The user-provided `code` portion of the filename must follow these rules:
- Lowercase alphanumeric characters, hyphens, and underscores only
- Maximum 30 characters
- Validated at input time

## Migration

Existing `storage_*.json` files in region folders (e.g. `storage_pchip.json`, `storage_move_avg.json` in Jamaica) will be migrated to the new subfolder structure and renamed to follow the new convention.
