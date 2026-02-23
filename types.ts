
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
}

export interface ChartPoint {
  date: number; // timestamp
  value: number;
  isInterpolated: boolean;
}

export interface StorageAnalysisParams {
  startDate: string;
  endDate: string;
  resolution: number;
  storageCoefficient: number;
  interval: '3months' | '6months' | '1year';
  volumeUnit: string;
  title: string;
  minObservations: number;
  minTimeSpanYears: number;
}

export interface StorageGrid {
  minLng: number;
  minLat: number;
  dx: number;
  dy: number;
  nx: number;
  ny: number;
  mask: (0 | 1)[];
}

export interface StorageFrame {
  date: string;
  values: (number | null)[];
}

export interface StorageAnalysisResult {
  version: number;
  title: string;
  code: string;
  aquiferId: string;
  aquiferName: string;
  regionId: string;
  params: StorageAnalysisParams;
  grid: StorageGrid;
  frames: StorageFrame[];
  storageSeries: { date: string; value: number }[];
  createdAt: string;
}

export interface StorageAnalysisMeta {
  title: string;
  code: string;
  aquiferId: string;
  aquiferName: string;
  regionId: string;
  params: StorageAnalysisParams;
  createdAt: string;
}
