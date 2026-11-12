import type { DataSource } from './services/dataStore';


export interface DataType {
  code: string;
  name: string;
  unit: string;
}

export interface CatalogParameter {
  name: string;
  unit: string;
  group: string;
  /** US EPA drinking water standard, in the parameter's unit */
  epa: number | null;
  /** What kind of EPA standard: enforceable maximum contaminant level,
   *  secondary (taste, odor, staining) or the action level for lead and copper */
  epaKind?: 'mcl' | 'secondary' | 'action';
  /** WHO guideline value, in the parameter's unit */
  who: number | null;
  wqp?: {
    characteristicName: string;
    sampleFraction: string | null;
  };
}

export interface ParameterCatalog {
  parameters: Record<string, CatalogParameter>;
}

export interface RegionMeta {
  id: string;
  name: string;
  lengthUnit: 'ft' | 'm';
  singleUnit: boolean;
  /** Non-catalog parameters this region uses (trichloroethylene, etc). Catalog
   *  parameters appear implicitly when their data file exists. Must not
   *  collide with any catalog code. */
  customDataTypes: DataType[];
  /** Scanned server-side and attached by the /api/regions endpoint — list
   *  of `data_*.csv` files currently on disk in the region folder. */
  dataFiles?: string[];
}

export interface Region {
  id: string;
  name: string;
  lengthUnit: 'ft' | 'm';
  singleUnit: boolean;
  customDataTypes: DataType[];
  /** Effective data type set for this region: WTE + catalog entries that
   *  have data + custom types that have data. Computed at load time. */
  effectiveDataTypes: DataType[];
  geojson: any;
  bounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
  /** Sample Data ships with the app and is read-only; My Data is the user's own. */
  source: DataSource;
}

export interface Aquifer {
  id: string;
  name: string;
  regionId: string;
  geojson: any;
  bounds: [number, number, number, number];
  labelPoint: [number, number]; // [lat, lng] for label placement
}

export interface Well {
  id: string;
  name: string;
  lat: number;
  lng: number;
  gse: number; // Ground Surface Elevation
  /** Depth of the finished well below the ground, in the region's length unit; undefined when unknown */
  depth?: number;
  aquiferId: string;
  aquiferName: string;
  regionId: string;
}

export interface Measurement {
  wellId: string;
  wellName: string;
  date: string; // ISO or human readable
  value: number; // Measurement value (e.g. Water Table Elevation)
  dataType: string; // Data type code (e.g. 'wte')
  aquiferId: string;
  regionId: string;
}

export interface ChartPoint {
  date: number; // timestamp
  value: number;
  isInterpolated: boolean;
}

export interface RasterAnalysisParams {
  startDate: string;
  endDate: string;
  resolution: number;
  interval: '3months' | '6months' | '1year';
  title: string;
  minObservations: number;
  minTimeSpanYears: number;
  smoothingMethod: 'pchip' | 'linear' | 'moving-average';
  smoothingMonths: number;
}

export interface RasterGrid {
  minLng: number;
  minLat: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  mask: (0 | 1)[];
}

export interface RasterFrame {
  date: string;
  values: (number | null)[];
}

export type VariogramModel = 'gaussian' | 'spherical' | 'exponential';
export type KrigingRangeMode = 'auto' | 'custom' | 'percentage';
export type IdwNodalFunction = 'classic' | 'gradient' | 'quadratic';
export type IdwNeighborMode = 'all' | 'nearest';
export type SpatialMethod = 'kriging' | 'idw';

export interface TemporalOptions {
  method: 'pchip' | 'linear' | 'moving-average' | 'model' | 'model-direct' | 'model-mavg';
  maWindow: number;
  startDate: string;
  endDate: string;
  interval: '3months' | '6months' | '1year';
  minObservations: number;
  minTimeSpan: number;
  modelCode?: string;
  modelFilePath?: string;
}

export interface KrigingOptions {
  variogramModel: VariogramModel;
  nugget: boolean;
  rangeMode: KrigingRangeMode;
  rangeValue: number | null;
}

export interface IdwOptions {
  exponent: number;
  nodalFunction: IdwNodalFunction;
  neighborMode: IdwNeighborMode;
  neighborCount: number;
}

export interface GeneralInterpolationOptions {
  truncateLow: boolean;
  truncateLowValue: number;
  truncateHigh: boolean;
  truncateHighValue: number;
  logInterpolation: boolean;
}

export interface RasterOptions {
  temporal: TemporalOptions;
  spatial: {
    method: SpatialMethod;
    resolution: number;
    kriging: KrigingOptions;
    idw: IdwOptions;
  };
  general: GeneralInterpolationOptions;
  /** Wells of the aquifer less than `meters` apart: the well each place kept */
  places?: RasterPlaceOptions;
}

/** Which well a place keeps: see services/sharedLocations.ts */
export type PlaceKeepRule = 'neighbors' | 'record' | 'count' | 'shallowest' | 'deepest';

/** How a map handled wells at one place: one kept at each, the others left out */
export interface RasterPlaceOptions {
  meters: number;
  rule: PlaceKeepRule;
  places: number;
  /** Places where the well was picked by hand, not by the rule */
  byHand: number;
  /** Wells left out of the map, with the well kept at their place */
  leftOut: { id: string; keptId: string }[];
}

export interface RasterFrameStats {
  date: string;
  count: number;
  min: number;
  max: number;
  mean: number;
  std: number;
  median: number;
  p25: number;
  p75: number;
}

export interface RasterAnalysisResult {
  version: number;
  title: string;
  code: string;
  aquiferId: string;
  aquiferName: string;
  regionId: string;
  dataType: string;
  params: RasterAnalysisParams;
  grid: RasterGrid;
  frames: RasterFrame[];
  createdAt: string;
  options?: RasterOptions;
  generatedAt?: string;
  stats?: RasterFrameStats[];
  /** Wells closer than the place distance, and the places they share, averaged into one point each
   *  (maps made before Spatial Analysis kept one well per place, at 10 m) */
  colocated?: { wells: number; places: number };
}

export interface CrossSectionProfile {
  start: { lat: number; lng: number };
  end: { lat: number; lng: number };
  totalLength: number;          // in region's length unit
  distances: number[];          // sample distances along the line
  profiles: (number | null)[][]; // profiles[frameIdx][sampleIdx]
  frameDates: string[];         // mirrors frames[].date
  elevationRange: [number, number]; // [min, max] across all frames
}

export interface RasterAnalysisMeta {
  title: string;
  code: string;
  aquiferId: string;
  aquiferName: string;
  regionId: string;
  filePath: string;
  dataType: string;
  params: RasterAnalysisParams;
  createdAt: string;
  options?: RasterOptions;
  generatedAt?: string;
  colocated?: { wells: number; places: number };
}

export interface ImputationParams {
  startDate: string;       // output start
  endDate: string;         // output end
  gldasStartDate: string;  // training start (full GLDAS range)
  gldasEndDate: string;    // training end
  minSamples: number;
  gapSize: number;       // days
  padSize: number;       // days
  hiddenUnits: number;
  lambda: number;
  fits?: number;         // ELM fits averaged for each well; absent in models made before averaging, which used one
}

/**
 * A well's hold-out check: the readings between `from` and `to` were left out, the well was fitted again on the rest, and
 * the stretch was filled both by the model (shifted, as saved) and by the PCHIP curve across it. `model` and `pchip` are
 * the RMSE of each against the `n` hidden readings scored, in the region's length unit.
 */
export interface ImputationCheck {
  from: string;
  to: string;
  n: number;
  model: number;
  pchip: number;
}

export interface ImputationWellMetrics {
  r2: number;
  rmse: number;
  check?: ImputationCheck;  // absent when the well has too few readings to hide a stretch, and in models made before the check
}

export interface ImputationDataRow {
  well_id: string;
  date: string;          // ISO date, monthly
  model: number | null;  // ELM prediction
  pchip: number | null;  // PCHIP interpolation
  combined: number;      // the saved series: pchip where available, else the model shifted to meet pchip (models made before
                         // the shift hold the model unshifted)
}

export interface ImputationModelResult {
  title: string;
  code: string;
  aquiferId: string;
  aquiferName: string;
  regionId: string;
  dataType: 'wte';
  filePath: string;
  createdAt: string;
  params: ImputationParams;
  wellMetrics: Record<string, ImputationWellMetrics>;
  data: ImputationDataRow[];
  log: string[];
}

// Lightweight version for listing (no data/log arrays)
export interface ImputationModelMeta {
  title: string;
  code: string;
  aquiferId: string;
  aquiferName: string;
  regionId: string;
  filePath: string;
  dataType: 'wte';
  params: ImputationParams;
  createdAt: string;
  wellMetrics: Record<string, ImputationWellMetrics>;
}

/** What the map draws, set from the DISPLAY section of the left panel. */
export interface MapDisplay {
  showAquiferNames: boolean;
  showAquiferIds: boolean;
  showWells: boolean;
  showWellNames: boolean;
  showWellIds: boolean;
  /** Hide wells with fewer measurements than this. */
  minObs: number;
  /** Show only wells whose record overlaps filterMinYear..filterMaxYear. Years are
      strings because they are typed; a filter applies once a year has 4 digits. */
  filterDates: boolean;
  filterMinYear: string;
  filterMaxYear: string;
  labelFontSize: number;
}

export const DEFAULT_MAP_DISPLAY: MapDisplay = {
  showAquiferNames: true,
  showAquiferIds: false,
  showWells: true,
  showWellNames: false,
  showWellIds: false,
  minObs: 0,
  filterDates: false,
  filterMinYear: '',
  filterMaxYear: '',
  labelFontSize: 9,
};
