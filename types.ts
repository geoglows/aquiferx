
export interface DataType {
  code: string;
  name: string;
  unit: string;
}

export interface RegionMeta {
  id: string;
  name: string;
  lengthUnit: 'ft' | 'm';
  singleUnit: boolean;
  dataTypes: DataType[];
}

export interface Region {
  id: string;
  name: string;
  lengthUnit: 'ft' | 'm';
  singleUnit: boolean;
  dataTypes: DataType[];
  geojson: any;
  bounds: [number, number, number, number]; // [minLat, minLng, maxLat, maxLng]
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
  method: 'pchip' | 'linear' | 'moving-average';
  maWindow: number;
  startDate: string;
  endDate: string;
  interval: '3months' | '6months' | '1year';
  minObservations: number;
  minTimeSpan: number;
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
}
