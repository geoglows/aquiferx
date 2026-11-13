import React, { useState, useMemo, useRef, useEffect, useCallback } from 'react';
import { X, ChevronLeft, ChevronRight, Play, Loader2, CheckCircle2, AlertTriangle, Download } from 'lucide-react';
import {
  BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from 'recharts';
import {
  Aquifer, Region, Well, Measurement, DataType, RasterAnalysisResult,
  VariogramModel, KrigingRangeMode, IdwNodalFunction, IdwNeighborMode, SpatialMethod,
  ImputationModelMeta, ImputationModelResult, PlaceKeepRule,
} from '../types';
import { RasterPipelineInput } from '../services/rasterAnalysis';
import { startRasterAnalysis, AnalysisRun } from '../services/analysisClient';
import { isPipelineCancelled } from '../services/pipelineCancel';
import { slugify } from '../utils/strings';
import { COLOCATED_METERS } from '../utils/geo';
import { readJson } from '../services/dataStore';
import { downloadCsv } from '../services/importUtils';
import {
  findPlaces, describePlaces, chooseWell, placeReportRows, KeepChoice, Place, PlacePoint, Reading,
  KEEP_RULE_LABELS, PLACE_REPORT_HEADERS, NEIGHBOR_COMPARISON,
} from '../services/sharedLocations';
import PchipPreviewCanvas from './PchipPreviewCanvas';

interface SpatialAnalysisDialogProps {
  aquifer: Aquifer;
  region: Region;
  wells: Well[];
  measurements: Measurement[];
  dataType: DataType;
  existingCodes: string[];
  onClose: () => void;
  onComplete: (result: RasterAnalysisResult) => void;
  availableModels?: ImputationModelMeta[];
}

const MS_PER_YEAR = 365.25 * 86400000;
const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const INTERVAL_LABELS = { '1year': '1 year', '6months': '6 months', '3months': '3 months' } as const;
const pct = (x: number) => `${Math.round(100 * x)}%`;

// 2 is shown only when the aquifer has wells at one place
type Step = 1 | 2 | 3 | 4 | 'running' | 'complete';

const SpatialAnalysisDialog: React.FC<SpatialAnalysisDialogProps> = ({
  aquifer, region, wells, measurements, dataType, existingCodes, onClose, onComplete, availableModels,
}) => {
  const [step, setStep] = useState<Step>(1);
  const [progressText, setProgressText] = useState('');
  const [progressPct, setProgressPct] = useState(0);
  const [result, setResult] = useState<RasterAnalysisResult | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const cancelledRef = useRef(false);
  const runRef = useRef<AnalysisRun<RasterAnalysisResult> | null>(null);

  // --- Temporal options (Step 1) ---
  const [resolution, setResolution] = useState(50);
  const [interval, setInterval] = useState<'3months' | '6months' | '1year'>('1year');
  const [minObs, setMinObs] = useState(5);
  const [minSpanYears, setMinSpanYears] = useState(5);
  const [smoothingMethod, setSmoothingMethod] = useState<'pchip' | 'moving-average' | 'model-direct' | 'model-mavg'>('pchip');
  const [smoothingMonths, setSmoothingMonths] = useState(12);
  const [selectedModelCode, setSelectedModelCode] = useState<string>('');
  const [selectedModelFilePath, setSelectedModelFilePath] = useState<string>('');
  const [dataSource, setDataSource] = useState<'raw' | 'model'>('raw');
  // Hold each well's first reading before its record and its last reading after it, up to holdYears
  const [hold, setHold] = useState(dataType.code === 'wte');
  const [holdYears, setHoldYears] = useState(10);

  // --- Spatial options (Step 2) ---
  const [spatialMethod, setSpatialMethod] = useState<SpatialMethod>('kriging');
  const [variogramModel, setVariogramModel] = useState<VariogramModel>('exponential');
  const [nuggetEnabled, setNuggetEnabled] = useState(false);
  const [rangeMode, setRangeMode] = useState<KrigingRangeMode>('auto');
  const [rangeValue, setRangeValue] = useState<number>(33);
  const [idwExponent, setIdwExponent] = useState(2);
  const [nodalFunction, setNodalFunction] = useState<IdwNodalFunction>('classic');
  const [neighborMode, setNeighborMode] = useState<IdwNeighborMode>('all');
  const [neighborCount, setNeighborCount] = useState(12);

  // --- General options (Step 2) ---
  const [truncateLow, setTruncateLow] = useState(false);
  const [truncateLowValue, setTruncateLowValue] = useState(0);
  const [truncateHigh, setTruncateHigh] = useState(false);
  const [truncateHighValue, setTruncateHighValue] = useState(0);
  const [logInterpolation, setLogInterpolation] = useState(false);

  // --- Wells at one place (Step 2) ---
  const [placeMeters, setPlaceMeters] = useState(COLOCATED_METERS);
  const [keepRule, setKeepRule] = useState<PlaceKeepRule>('neighbors');
  // Places where the user picked the well: place key → well ID
  const [byHand, setByHand] = useState<Map<string, string>>(new Map());

  // --- Title (Step 4) ---
  const [title, setTitle] = useState('');

  // Build well key set for fast lookup (regionId:aquiferId:wellId for global uniqueness)
  const wellKeySet = useMemo(() => new Set(wells.map(w => `${w.regionId}:${w.aquiferId}:${w.id}`)), [wells]);

  // Compute measurements for the target data type in this aquifer
  const wteMeasurements = useMemo(() =>
    measurements.filter(m => m.dataType === dataType.code && wellKeySet.has(`${m.regionId}:${m.aquiferId}:${m.wellId}`)),
  [measurements, wellKeySet, dataType.code]);

  // Check if any values are non-positive (disables log interpolation)
  const hasNonPositiveValues = useMemo(() => {
    for (const m of wteMeasurements) {
      if (m.value <= 0) return true;
    }
    return false;
  }, [wteMeasurements]);

  // Initialize max observed for truncation default
  useEffect(() => {
    if (wteMeasurements.length > 0) {
      let max = -Infinity;
      for (const m of wteMeasurements) if (m.value > max) max = m.value;
      setTruncateHighValue(Math.ceil(max));
    }
  }, [wteMeasurements]);

  // Each well's readings, sorted by time
  const readings = useMemo(() => {
    const out = new Map<string, Reading[]>();
    for (const m of wteMeasurements) {
      const t = new Date(m.date).getTime();
      if (isNaN(t) || !Number.isFinite(m.value)) continue;
      let list = out.get(m.wellId);
      if (!list) out.set(m.wellId, list = []);
      list.push({ t, v: m.value });
    }
    for (const list of out.values()) list.sort((a, b) => a.t - b.t);
    return out;
  }, [wteMeasurements]);

  // Wells with at least 2 readings (drawn on the preview)
  const usableWellCount = useMemo(() => [...readings.values()].filter(l => l.length >= 2).length, [readings]);

  // The wells that go on a map of measurements: at least minObs readings over at least minSpanYears, as the pipeline counts them
  const qualifiedIds = useMemo(() => {
    const ids = new Set<string>();
    for (const [id, list] of readings) {
      if (list.length < Math.max(2, minObs)) continue;
      if ((list[list.length - 1].t - list[0].t) / MS_PER_YEAR >= minSpanYears) ids.add(id);
    }
    return ids;
  }, [readings, minObs, minSpanYears]);
  const qualifiedWellCount = qualifiedIds.size;
  const omittedWellCount = readings.size - qualifiedWellCount;

  // Map dates fall on the 1st of one month each year (a 6- or 3-month interval starts from it). The month starts as the
  // one with the most readings of the wells that go on the map.
  const monthShares = useMemo(() => {
    const counts = new Array(12).fill(0);
    let n = 0;
    for (const [id, list] of readings) {
      if (!qualifiedIds.has(id)) continue;
      for (const r of list) { counts[new Date(r.t).getUTCMonth()]++; n++; }
    }
    return n > 0 ? counts.map(c => c / n) : null;
  }, [readings, qualifiedIds]);
  const busiestMonth = monthShares ? monthShares.indexOf(Math.max(...monthShares)) + 1 : 1;
  const [monthChoice, setMonthChoice] = useState<number | null>(null);   // null: the busiest month
  const month = monthChoice ?? busiestMonth;

  // The Start and End years the dialog fills in: the first and last year in which at least 1 in 5 of the wells that go on
  // the map (and at least 10) have a reading before that year's map date and one after it. Held years do not count.
  const defaultYears = useMemo(() => {
    const spans: [number, number][] = [];
    for (const [id, list] of readings) if (qualifiedIds.has(id)) spans.push([list[0].t, list[list.length - 1].t]);
    const pool = spans.length > 0 ? spans
      : [...readings.values()].filter(l => l.length > 0).map(l => [l[0].t, l[l.length - 1].t] as [number, number]);
    if (pool.length === 0) return null;
    let lo = Infinity, hi = -Infinity;
    for (const [a, b] of pool) { if (a < lo) lo = a; if (b > hi) hi = b; }
    const y0 = new Date(lo).getUTCFullYear(), y1 = new Date(hi).getUTCFullYear();
    const need = Math.max(10, Math.ceil(spans.length * 0.2));
    let first: number | null = null, last: number | null = null;
    if (spans.length > 0) {
      for (let y = y0; y <= y1; y++) {
        const t = Date.UTC(y, month - 1, 1);
        let k = 0;
        for (const [a, b] of spans) if (a <= t && t <= b) k++;
        if (k >= need) { if (first === null) first = y; last = y; }
      }
    }
    return first !== null && last !== null ? { first, last } : { first: y0, last: y1 };
  }, [readings, qualifiedIds, month]);
  // Years typed by the user; null: the default
  const [startYearChoice, setStartYearChoice] = useState<number | null>(null);
  const [endYearChoice, setEndYearChoice] = useState<number | null>(null);

  // Model date range for clamping
  const modelDateRange = useMemo(() => {
    if (dataSource !== 'model' || !selectedModelCode || !availableModels) return null;
    const m = availableModels.find(mm => mm.code === selectedModelCode);
    if (!m?.params) return null;
    return { min: m.params.startDate, max: m.params.endDate };
  }, [dataSource, selectedModelCode, availableModels]);

  // With a model, the years whose map date lies inside the model's months
  const mm = String(month).padStart(2, '0');
  const yearBounds = useMemo(() => {
    if (!modelDateRange) return null;
    let lo = parseInt(modelDateRange.min);
    if (`${lo}-${mm}-01` < modelDateRange.min) lo++;
    let hi = parseInt(modelDateRange.max);
    if (`${hi}-${mm}-01` > modelDateRange.max) hi--;
    return { lo, hi };
  }, [modelDateRange, mm]);
  const clampYear = (y: number) => (yearBounds ? Math.min(yearBounds.hi, Math.max(yearBounds.lo, y)) : y);
  const startYear = defaultYears ? clampYear(startYearChoice ?? defaultYears.first) : null;
  const endYear = defaultYears ? clampYear(endYearChoice ?? defaultYears.last) : null;
  const startDate = startYear != null ? `${startYear}-${mm}-01` : '';
  const endDate = endYear != null ? `${endYear}-${mm}-01` : '';
  const stepMonths = interval === '1year' ? 12 : interval === '6months' ? 6 : 3;
  const mapCount = startYear != null && endYear != null && endYear >= startYear
    ? Math.floor(((endYear - startYear) * 12) / stepMonths) + 1 : 0;

  // Show data source toggle only when WTE + models exist
  const showDataSource = dataType.code === 'wte' && availableModels && availableModels.length > 0;

  // Handle switching between measurements and model data source
  const handleDataSourceChange = useCallback((source: 'raw' | 'model') => {
    setDataSource(source);
    if (source === 'model') {
      // Auto-select first model if none selected
      if (availableModels && availableModels.length > 0) {
        const m = availableModels[0];
        setSelectedModelCode(m.code);
        setSelectedModelFilePath(m.filePath);
      }
      setSmoothingMethod('model-direct');
    } else {
      setSmoothingMethod('pchip');
    }
  }, [availableModels]);

  // The years are clamped to the chosen model's months as they are read
  const handleModelChange = useCallback((code: string) => {
    setSelectedModelCode(code);
    const m = availableModels?.find(mm => mm.code === code);
    if (m) setSelectedModelFilePath(m.filePath);
  }, [availableModels]);

  const code = slugify(title);
  const hasConflict = existingCodes.includes(code);

  // Validation
  const step1Valid = startYear != null && endYear != null && startYear <= endYear && wells.length > 0;
  const spatialValid = (() => {
    if (spatialMethod === 'idw' && nodalFunction === 'quadratic' && neighborMode === 'nearest' && neighborCount < 6) return false;
    if (rangeMode === 'custom' && (rangeValue <= 0)) return false;
    if (rangeMode === 'percentage' && (rangeValue <= 0 || rangeValue > 100)) return false;
    return true;
  })();
  const titleValid = title.trim().length > 0 && !hasConflict;

  const handleRun = async () => {
    if (step === 'running') return; // a pipeline is already in flight
    cancelledRef.current = false;
    setStep('running');
    setErrorMessage(null);

    const input: RasterPipelineInput = {
      temporal: {
        method: smoothingMethod,
        maWindow: smoothingMonths,
        startDate,
        endDate,
        interval,
        minObservations: minObs,
        minTimeSpan: minSpanYears,
        ...(dataSource === 'raw' && hold ? { holdYears } : {}),
        ...((smoothingMethod === 'model-direct' || smoothingMethod === 'model-mavg') ? { modelCode: selectedModelCode, modelFilePath: selectedModelFilePath } : {}),
      },
      spatial: {
        method: spatialMethod,
        resolution,
        kriging: {
          variogramModel,
          nugget: nuggetEnabled,
          rangeMode,
          rangeValue: rangeMode === 'auto' ? null : rangeValue,
        },
        idw: {
          exponent: idwExponent,
          nodalFunction,
          neighborMode,
          neighborCount,
        },
      },
      general: {
        truncateLow,
        truncateLowValue,
        truncateHigh,
        truncateHighValue,
        logInterpolation,
      },
      title,
      ...(places.length > 0 ? {
        places: {
          meters: placeMeters,
          rule: keepRule,
          places: places.length,
          byHand: choices.filter(c => c.how === 'picked by hand').length,
          leftOut: choices.flatMap(c => [...c.reasons.keys()].map(id => ({ id, keptId: c.keptId }))),
        },
      } : {}),
    };
    const runWells = wells.filter(w => !leftOutIds.has(w.id));
    const runWellKeys = new Set(runWells.map(w => `${w.regionId}:${w.aquiferId}:${w.id}`));

    try {
      const run = startRasterAnalysis(
        {
          input,
          dataType: dataType.code,
          aquifer,
          region,
          wells: runWells,
          measurements: measurements.filter(m => runWellKeys.has(`${m.regionId}:${m.aquiferId}:${m.wellId}`)),
        },
        (stepText, pct) => {
          if (!cancelledRef.current) {
            setProgressText(stepText);
            setProgressPct(pct);
          }
        }
      );
      runRef.current = run;
      const result = await run.promise;
      if (!cancelledRef.current) {
        setResult(result);
        setStep('complete');
      }
    } catch (err) {
      // Cancellation throws to stop the compute — it isn't an error
      if (isPipelineCancelled(err)) return;
      console.error('Raster analysis failed:', err);
      setErrorMessage(err instanceof Error ? err.message : String(err));
      setStep(4);
    } finally {
      runRef.current = null;
    }
  };

  const handleCancel = () => {
    if (step === 'running') {
      cancelledRef.current = true;
      runRef.current?.cancel();
    }
    setStep(1);
    setProgressPct(0);
    setProgressText('');
    setErrorMessage(null);
  };

  // Date range markers for charts
  const startTs = startDate ? Date.parse(startDate) : undefined;
  const endTs = endDate ? Date.parse(endDate) : undefined;

  // ---------------------------------------------------------------------------
  // Wells at one place: wells less than placeMeters apart among the wells the
  // map will use. One is kept at each place, by the rule or by hand.
  // ---------------------------------------------------------------------------

  // A map from a gap-filling model uses the model's wells
  const [modelWellIds, setModelWellIds] = useState<Set<string> | null>(null);
  useEffect(() => {
    if (dataSource !== 'model' || !selectedModelFilePath) { setModelWellIds(null); return; }
    let live = true;
    setModelWellIds(null);
    readJson<ImputationModelResult>(selectedModelFilePath)
      .then(m => { if (live) setModelWellIds(new Set(Object.keys(m?.data ?? {}))); })
      .catch(() => { if (live) setModelWellIds(new Set()); });
    return () => { live = false; };
  }, [dataSource, selectedModelFilePath]);
  const placesLoading = dataSource === 'model' && modelWellIds === null;

  // The wells that go on the map: the model's wells for Imputed Data, else those meeting the two minimums
  const mapIds = useMemo(
    () => (dataSource === 'model' ? (modelWellIds ?? new Set<string>()) : qualifiedIds),
    [dataSource, modelWellIds, qualifiedIds],
  );

  // Wells read in each half-year, split into the wells that go on the map and the rest
  const densityData = useMemo(() => {
    let lo = Infinity, hi = -Infinity;
    for (const list of readings.values()) {
      if (list.length === 0) continue;
      if (list[0].t < lo) lo = list[0].t;
      if (list[list.length - 1].t > hi) hi = list[list.length - 1].t;
    }
    if (lo === Infinity) return [];
    const y0 = new Date(lo).getUTCFullYear(), y1 = new Date(hi).getUTCFullYear();
    const nBins = (y1 - y0 + 1) * 2;
    const onMap = new Array(nBins).fill(0), other = new Array(nBins).fill(0);
    for (const [id, list] of readings) {
      const bins = new Set<number>();
      for (const r of list) {
        const d = new Date(r.t);
        bins.add((d.getUTCFullYear() - y0) * 2 + (d.getUTCMonth() < 6 ? 0 : 1));
      }
      const into = mapIds.has(id) ? onMap : other;
      for (const b of bins) into[b]++;
    }
    return Array.from({ length: nBins }, (_, b) => ({
      label: `${y0 + (b >> 1)} ${b & 1 ? 'H2' : 'H1'}`, onMap: onMap[b], other: other[b],
    }));
  }, [readings, mapIds]);

  const toPoint = (w: Well): PlacePoint => ({ id: w.id, name: w.name, lat: w.lat, lng: w.lng, ...(w.depth != null ? { depth: w.depth } : {}) });

  const placeGroups = useMemo(() => {
    const use = dataSource === 'model' ? modelWellIds : qualifiedIds;
    if (!use || !(placeMeters > 0)) return [];
    return findPlaces(wells.filter(w => use.has(w.id) && Number.isFinite(w.lat) && Number.isFinite(w.lng)).map(toPoint), placeMeters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [wells, dataSource, modelWellIds, qualifiedIds, placeMeters]);

  // The step stays once shown, so a distance that finds no places can be changed back
  const hasPlaceStep = placeGroups.length > 0 || placeMeters !== COLOCATED_METERS;

  // The facts the rules need, computed once the step is reached: nearby wells
  // are those with readings that are not at any place themselves
  const places: Place[] = useMemo(() => {
    if (step === 1 || placeGroups.length === 0) return [];
    const withReadings = wells.filter(w => readings.has(w.id) && Number.isFinite(w.lat) && Number.isFinite(w.lng)).map(toPoint);
    const atPlaces = new Set(findPlaces(withReadings, placeMeters).flat().map(w => w.id));
    const neighbors = withReadings.filter(w => !atPlaces.has(w.id));
    const start = new Date(startDate).getTime(), end = new Date(endDate).getTime();
    return describePlaces(placeGroups, readings, neighbors, start, end);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step === 1, placeGroups, wells, readings, placeMeters, startDate, endDate]);

  const choices = useMemo(() => places.map((place): KeepChoice => {
    const picked = byHand.get(place.key);
    if (picked && place.wells.some(w => w.id === picked)) {
      const reasons = new Map(place.wells.filter(w => w.id !== picked).map(w => [w.id, `${picked} picked by hand`] as [string, string]));
      return { keptId: picked, how: 'picked by hand', reasons };
    }
    return chooseWell(place, keepRule);
  }), [places, keepRule, byHand]);

  const leftOutIds = useMemo(() => {
    const out = new Set<string>();
    for (const c of choices) for (const id of c.reasons.keys()) out.add(id);
    return out;
  }, [choices]);

  const visibleSteps: { n: number; label: string }[] = [
    { n: 1, label: 'Temporal' },
    ...(hasPlaceStep ? [{ n: 2, label: 'Wells at One Place' }] : []),
    { n: 3, label: 'Spatial' },
    { n: 4, label: 'Title & Run' },
  ];

  const stepNumber = typeof step === 'number' ? step : null;

  // --- Input class helpers ---
  const inputCls = "w-full px-2 py-1.5 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500";
  const labelCls = "block text-xs font-medium text-slate-600 mb-1";
  const radioCls = (active: boolean) =>
    `px-3 py-1.5 text-xs font-medium rounded-md border cursor-pointer transition-colors ${
      active
        ? 'bg-emerald-600 text-white border-emerald-600'
        : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'
    }`;

  return (
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/40">
      <div className="bg-white rounded-xl shadow-2xl w-[900px] max-h-[90vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
          <div>
            <h2 className="text-lg font-bold text-slate-800">Build Spatial Raster</h2>
            <p className="text-sm text-slate-500">{aquifer.name} &mdash; {region.name}</p>
          </div>
          <div className="flex items-center gap-4">
            {/* Step indicator */}
            {stepNumber && (
              <div className="flex items-center gap-2 text-xs text-slate-500">
                {visibleSteps.map(({ n, label }, i) => {
                  const sn = i + 1;
                  const isActive = n === stepNumber;
                  const isDone = n < stepNumber;
                  return (
                    <React.Fragment key={i}>
                      {i > 0 && <div className="w-4 h-px bg-slate-300" />}
                      <div className={`flex items-center gap-1 ${isActive ? 'text-emerald-600 font-semibold' : isDone ? 'text-emerald-500' : 'text-slate-400'}`}>
                        <div className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] font-bold ${
                          isActive ? 'bg-emerald-600 text-white' : isDone ? 'bg-emerald-100 text-emerald-600' : 'bg-slate-100 text-slate-400'
                        }`}>{sn}</div>
                        <span className="hidden sm:inline">{label}</span>
                      </div>
                    </React.Fragment>
                  );
                })}
              </div>
            )}
            <button
              onClick={() => { cancelledRef.current = true; runRef.current?.cancel(); onClose(); }}
              className="p-1 hover:bg-slate-100 rounded-lg transition-colors"
            >
              <X size={20} className="text-slate-400" />
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto px-6 py-4">
          {/* ===== STEP 1: Temporal ===== */}
          {step === 1 && (
            <div className="space-y-5">
              {/* Data Source selector (WTE + models only) */}
              {showDataSource && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-2">Data Source</h3>
                  <div className="flex items-center gap-3">
                    <div className="flex gap-2">
                      <button onClick={() => handleDataSourceChange('raw')} className={radioCls(dataSource === 'raw')}>
                        Measurements
                      </button>
                      <button onClick={() => handleDataSourceChange('model')} className={radioCls(dataSource === 'model')}>
                        Imputed Data
                      </button>
                    </div>
                    {dataSource === 'model' && availableModels && (
                      availableModels.length === 1 ? (
                        <span className="text-xs text-slate-500">{availableModels[0].title}</span>
                      ) : (
                        <select
                          value={selectedModelCode}
                          onChange={e => handleModelChange(e.target.value)}
                          className="px-2 py-1 border border-slate-300 rounded-md text-xs focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500"
                        >
                          {availableModels.map(m => (
                            <option key={m.code} value={m.code}>{m.title}</option>
                          ))}
                        </select>
                      )
                    )}
                  </div>
                </div>
              )}

              {/* Time series preview: the wells that go on the map in colour, the rest in grey */}
              {wteMeasurements.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">
                    {dataType.name}: {mapIds.size} wells on the maps (of {usableWellCount} with 2 or more readings)
                  </h3>
                  <div className="h-[180px] bg-slate-50 rounded-lg border border-slate-200">
                    <PchipPreviewCanvas
                      wells={wells}
                      wteMeasurements={wteMeasurements}
                      highlightIds={mapIds}
                      startTs={startTs}
                      endTs={endTs}
                      shadeRange={modelDateRange ? {
                        min: new Date(modelDateRange.min).getTime(),
                        max: new Date(modelDateRange.max).getTime(),
                      } : undefined}
                    />
                  </div>
                </div>
              )}

              {/* Wells read in each half-year */}
              {densityData.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">Wells read in each half-year</h3>
                  <div className="rfs-chart h-[130px] bg-slate-50 rounded-lg border border-slate-200 p-1">
                    <ResponsiveContainer width="100%" height="100%">
                      <BarChart data={densityData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                        <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="var(--chart-grid)" />
                        <XAxis dataKey="label" stroke="var(--chart-axis)" fontSize={9} interval="preserveStartEnd" />
                        <YAxis stroke="var(--chart-axis)" fontSize={10} />
                        <Tooltip
                          content={({ payload }) => {
                            if (!payload || payload.length === 0) return null;
                            const d = payload[0]?.payload;
                            return (
                              <div className="bg-white rounded shadow-md px-2 py-1 text-[10px] border border-slate-200">
                                <div className="text-slate-700 font-medium">{d?.label}</div>
                                <div className="text-emerald-700">{d?.onMap} wells on the maps</div>
                                <div className="text-slate-500">{d?.other} other wells</div>
                              </div>
                            );
                          }}
                        />
                        <Bar dataKey="onMap" stackId="wells" fill="#10b981" fillOpacity={0.8} />
                        <Bar dataKey="other" stackId="wells" fill="#94a3b8" fillOpacity={0.4} radius={[2, 2, 0, 0]} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                </div>
              )}

              {/* Options Form */}
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Start Year</label>
                  <input type="number" value={startYear ?? ''} step={1} min={yearBounds?.lo} max={yearBounds?.hi}
                    onChange={e => { const y = parseInt(e.target.value); if (!isNaN(y)) setStartYearChoice(y); }}
                    className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>End Year</label>
                  <input type="number" value={endYear ?? ''} step={1} min={yearBounds?.lo} max={yearBounds?.hi}
                    onChange={e => { const y = parseInt(e.target.value); if (!isNaN(y)) setEndYearChoice(y); }}
                    className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Month</label>
                  <select value={month} onChange={e => setMonthChoice(parseInt(e.target.value))} className={inputCls}>
                    {MONTH_NAMES.map((name, i) => <option key={name} value={i + 1}>{name}</option>)}
                  </select>
                  {monthShares && (
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      Most readings fall in {MONTH_NAMES[busiestMonth - 1]} ({pct(monthShares[busiestMonth - 1])}).
                      {month !== busiestMonth && ` ${MONTH_NAMES[month - 1]}: ${pct(monthShares[month - 1])}.`}
                    </p>
                  )}
                </div>
                <div>
                  <label className={labelCls}>Interval</label>
                  <select value={interval} onChange={e => setInterval(e.target.value as any)} className={inputCls}>
                    <option value="3months">3 months</option>
                    <option value="6months">6 months</option>
                    <option value="1year">1 year</option>
                  </select>
                  {mapCount > 0 && (
                    <p className="text-[10px] text-slate-500 mt-0.5">
                      {mapCount} map{mapCount === 1 ? '' : 's'}, each on the 1st of the month, from {MONTH_NAMES[month - 1]} {startYear} to {MONTH_NAMES[month - 1]} {endYear}
                    </p>
                  )}
                </div>
                {dataSource !== 'model' && (
                  <div>
                    <label className={labelCls}>Min Observations / Well</label>
                    <input type="number" value={minObs} min={2} max={100} step={1}
                      onChange={e => setMinObs(Math.max(2, parseInt(e.target.value) || 5))} className={inputCls} />
                  </div>
                )}
                {dataSource !== 'model' && (
                  <div>
                    <label className={labelCls}>Min Time Span / Well (years)</label>
                    <input type="number" value={minSpanYears} min={0} max={50} step={1}
                      onChange={e => setMinSpanYears(Math.max(0, parseFloat(e.target.value) || 5))} className={inputCls} />
                  </div>
                )}
                {dataSource !== 'model' && (
                  <div className="col-span-2">
                    <div className="flex items-center gap-3 text-xs">
                      <span className="text-emerald-600 font-medium">{qualifiedWellCount} wells qualify</span>
                      {omittedWellCount > 0 && (
                        <span className="text-slate-400">{omittedWellCount} omitted</span>
                      )}
                    </div>
                  </div>
                )}
                {dataSource !== 'model' && (
                  <div className="col-span-2">
                    <label className="flex items-center gap-2 cursor-pointer text-xs text-slate-600">
                      <input type="checkbox" checked={hold} onChange={e => setHold(e.target.checked)}
                        className="w-3.5 h-3.5 rounded accent-emerald-600" />
                      Hold each well's first and last readings for up to
                      <input type="number" value={holdYears} min={1} max={50} step={1} disabled={!hold}
                        onChange={e => setHoldYears(Math.max(1, Math.min(50, parseInt(e.target.value) || 10)))}
                        className="w-14 px-2 py-0.5 border border-slate-300 rounded-md text-sm disabled:opacity-50" />
                      years
                    </label>
                    <p className="text-[10px] text-slate-400 mt-0.5 ml-5">
                      Before a well's first reading the map uses that reading, and after its last reading the last one, so the
                      well stays on maps up to this many years beyond its record.
                    </p>
                  </div>
                )}
                <div>
                  <label className={labelCls}>Temporal Method</label>
                  {dataSource === 'model' ? (
                    <select value={smoothingMethod} onChange={e => setSmoothingMethod(e.target.value as any)} className={inputCls}>
                      <option value="model-direct">Direct</option>
                      <option value="model-mavg">Moving Average</option>
                    </select>
                  ) : (
                    <select value={smoothingMethod} onChange={e => setSmoothingMethod(e.target.value as any)} className={inputCls}>
                      <option value="pchip">PCHIP</option>
                      <option value="moving-average">Moving Average</option>
                    </select>
                  )}
                </div>
                {(smoothingMethod === 'moving-average' || smoothingMethod === 'model-mavg') && (
                  <div>
                    <label className={labelCls}>MA Window (months)</label>
                    <input type="number" value={smoothingMonths} min={1} max={60} step={1}
                      onChange={e => setSmoothingMonths(Math.max(1, Math.min(60, parseInt(e.target.value) || 12)))}
                      className={inputCls} />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ===== STEP 2: Wells at one place ===== */}
          {step === 2 && (() => {
            const unit = region.lengthUnit;
            const diffUnit = dataType.unit ? ` ${dataType.unit}` : '';
            const round1 = (x: number) => (Math.round(x * 10) / 10).toLocaleString();
            const ruleHelp: Record<PlaceKeepRule, string> = {
              neighbors: `Each well's readings in the period are compared with those of up to ${NEIGHBOR_COMPARISON.maxNeighbors} nearby wells read within ${NEIGHBOR_COMPARISON.days} days, and the well that differs least is kept. Only wells whose record covers at least half as much of the period as the best-covered well at the place take part. Where too few nearby wells were read at the same times, the well with the most readings is kept.`,
              record: 'The well whose record, from its first reading to its last, covers more of the period.',
              count: 'The well with the most readings in the period.',
              shallowest: 'By well depth. Where a well at the place has no depth, the well with the most readings is kept.',
              deepest: 'By well depth. Where a well at the place has no depth, the well with the most readings is kept.',
            };
            return (
              <div className="space-y-4">
                <div>
                  <h3 className="text-sm font-semibold text-slate-700 mb-1">Wells at One Place</h3>
                  <p className="text-xs text-slate-600 leading-relaxed">
                    {placeGroups.length > 0
                      ? <>{placeGroups.length} place{placeGroups.length === 1 ? ' has' : 's have'} more than one well, closer together than the distance below. </>
                      : <>No wells of this aquifer are closer together than the distance below. </>}
                    They are mostly nested wells, finished at different depths in one borehole or a few feet apart. Averaging
                    them would mix measurements from different depths, so the map uses one well at each place. The others stay in
                    the region and are left out of this map only.
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-x-6 gap-y-3">
                  <label className="flex items-center gap-2 text-xs text-slate-600">
                    Wells closer than
                    <input type="number" value={placeMeters} min={1} max={100} step={1}
                      onChange={e => setPlaceMeters(Math.max(1, Math.min(100, parseFloat(e.target.value) || 0)))}
                      className="w-16 px-2 py-1 border border-slate-300 rounded-md text-sm focus:ring-2 focus:ring-emerald-500 focus:border-emerald-500" />
                    m count as one place
                  </label>
                </div>

                {placesLoading && (
                  <p className="flex items-center gap-2 text-xs text-slate-500"><Loader2 size={12} className="animate-spin" /> Reading the model's wells...</p>
                )}

                {places.length > 0 && (
                  <>
                    <div>
                      <label className={labelCls}>Keep at each place</label>
                      <div className="flex flex-wrap gap-2">
                        {(Object.keys(KEEP_RULE_LABELS) as PlaceKeepRule[]).map(rule => (
                          <button key={rule} onClick={() => { setKeepRule(rule); setByHand(new Map()); }} className={radioCls(keepRule === rule)}>
                            {KEEP_RULE_LABELS[rule]}
                          </button>
                        ))}
                      </div>
                      <p className="text-xs text-slate-500 mt-1.5">{ruleHelp[keepRule]} Click another well in the list to keep it instead.</p>
                    </div>

                    <div className="border border-slate-200 rounded-lg max-h-[42vh] overflow-y-auto">
                      <table className="w-full text-xs">
                        <thead className="sticky top-0 bg-slate-100 text-slate-500">
                          <tr>
                            <th className="w-8 py-1.5"></th>
                            <th className="text-left font-medium py-1.5 pr-2">Well</th>
                            <th className="text-right font-medium py-1.5 pr-3">Depth</th>
                            <th className="text-right font-medium py-1.5 pr-3">Readings in period</th>
                            <th className="text-right font-medium py-1.5 pr-3">Record</th>
                            <th className="text-right font-medium py-1.5 pr-3">Differs from nearby wells</th>
                          </tr>
                        </thead>
                        <tbody>
                          {places.map((place, k) => {
                            const c = choices[k];
                            return (
                              <React.Fragment key={place.key}>
                                <tr className="bg-slate-50 border-t border-slate-200">
                                  <td colSpan={6} className="px-2 py-1 text-slate-500">
                                    Place {k + 1}
                                    {' · '}{place.spanMeters < 0.5 ? 'same coordinates' : `${round1(place.spanMeters)} m apart`}
                                    {' · kept: '}{c.how}
                                  </td>
                                </tr>
                                {place.wells.map(w => {
                                  const kept = w.id === c.keptId;
                                  return (
                                    <tr key={w.id}
                                      onClick={() => setByHand(prev => {
                                        const next = new Map(prev);
                                        if (chooseWell(place, keepRule).keptId === w.id) next.delete(place.key); else next.set(place.key, w.id);
                                        return next;
                                      })}
                                      className={`cursor-pointer ${kept ? 'text-slate-800' : 'text-slate-400 hover:text-slate-600'}`}>
                                      <td className="text-center py-1">
                                        <input type="radio" readOnly checked={kept} name={`place-${k}`} className="text-emerald-600 pointer-events-none" />
                                      </td>
                                      <td className="py-1 pr-2">
                                        <span className={kept ? 'font-medium' : ''}>{w.name || w.id}</span>
                                        {w.name && w.name !== w.id && <span className="ml-1.5 text-[10px] text-slate-400 font-mono">{w.id}</span>}
                                      </td>
                                      <td className="text-right py-1 pr-3">{w.depth != null ? `${w.depth.toLocaleString()} ${unit}` : '—'}</td>
                                      <td className="text-right py-1 pr-3">{w.count.toLocaleString()}</td>
                                      <td className="text-right py-1 pr-3">{w.first && w.last ? `${w.first.slice(0, 4)}–${w.last.slice(0, 4)}` : '—'}</td>
                                      <td className="text-right py-1 pr-3" title={w.medianDiff == null ? `${w.compared} reading${w.compared === 1 ? '' : 's'} could be compared; ${NEIGHBOR_COMPARISON.minCompared} are needed` : `median of ${w.compared} readings`}>
                                        {w.medianDiff != null ? `${round1(w.medianDiff)}${diffUnit}` : '—'}
                                      </td>
                                    </tr>
                                  );
                                })}
                              </React.Fragment>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>

                    <div className="flex items-center justify-between gap-2 text-xs">
                      <span className="text-slate-600">
                        <span className="font-medium">{leftOutIds.size} well{leftOutIds.size === 1 ? '' : 's'}</span> will be left out of this map
                        {byHand.size > 0 && <>, {byHand.size} place{byHand.size === 1 ? '' : 's'} picked by hand</>}.
                      </span>
                      <button
                        onClick={() => downloadCsv(`wells-at-one-place-${slugify(aquifer.name)}.csv`, PLACE_REPORT_HEADERS, placeReportRows(places, p => choices[places.indexOf(p)]))}
                        className="flex items-center gap-1.5 font-medium text-blue-700 hover:text-blue-900 hover:underline">
                        <Download size={13} /> Download the list (CSV)
                      </button>
                    </div>
                  </>
                )}
              </div>
            );
          })()}

          {/* ===== STEP 3: Spatial ===== */}
          {step === 3 && (
            <div className="space-y-5">
              {/* Spatial Method selector */}
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-2">Spatial Method</h3>
                <div className="flex gap-2">
                  <button onClick={() => setSpatialMethod('kriging')} className={radioCls(spatialMethod === 'kriging')}>
                    Kriging
                  </button>
                  <button onClick={() => setSpatialMethod('idw')} className={radioCls(spatialMethod === 'idw')}>
                    IDW (Inverse Distance)
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className={labelCls}>Resolution (columns)</label>
                  <input type="number" value={resolution} min={10} max={500} step={10}
                    onChange={e => setResolution(Math.max(10, parseInt(e.target.value) || 100))} className={inputCls} />
                </div>
              </div>

              {/* Method-specific options */}
              {spatialMethod === 'kriging' && (
                <div className="bg-slate-50 rounded-lg border border-slate-200 p-4 space-y-4">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide">Kriging Options</h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Variogram Model</label>
                      <select value={variogramModel} onChange={e => setVariogramModel(e.target.value as VariogramModel)} className={inputCls}>
                        <option value="gaussian">Gaussian</option>
                        <option value="spherical">Spherical</option>
                        <option value="exponential">Exponential</option>
                      </select>
                    </div>
                    <div className="flex items-end pb-1">
                      <label className="flex items-center gap-2 cursor-pointer">
                        <input type="checkbox" checked={nuggetEnabled}
                          onChange={e => setNuggetEnabled(e.target.checked)}
                          className="w-3.5 h-3.5 rounded accent-emerald-600" />
                        <span className="text-xs text-slate-600">Enable nugget</span>
                      </label>
                    </div>
                  </div>

                  <div>
                    <label className={labelCls}>Range</label>
                    <div className="flex gap-2 mb-2">
                      {(['auto', 'custom', 'percentage'] as KrigingRangeMode[]).map(mode => (
                        <button key={mode} onClick={() => setRangeMode(mode)} className={radioCls(rangeMode === mode)}>
                          {mode === 'auto' ? 'Auto (1/3 diagonal)' : mode === 'custom' ? 'Custom (meters)' : 'Percentage'}
                        </button>
                      ))}
                    </div>
                    {rangeMode !== 'auto' && (
                      <input type="number" value={rangeValue} min={0.1}
                        step={rangeMode === 'percentage' ? 1 : 100}
                        onChange={e => setRangeValue(parseFloat(e.target.value) || 0)}
                        className={inputCls}
                        placeholder={rangeMode === 'custom' ? 'Range in meters' : 'Percentage of diagonal'} />
                    )}
                  </div>
                </div>
              )}

              {spatialMethod === 'idw' && (
                <div className="bg-slate-50 rounded-lg border border-slate-200 p-4 space-y-4">
                  <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide">IDW Options</h4>

                  <div className="grid grid-cols-2 gap-4">
                    <div>
                      <label className={labelCls}>Exponent</label>
                      <input type="number" value={idwExponent} min={0.5} max={10} step={0.1}
                        onChange={e => setIdwExponent(Math.max(0.5, Math.min(10, parseFloat(e.target.value) || 2)))}
                        className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>Nodal Function</label>
                      <select value={nodalFunction} onChange={e => setNodalFunction(e.target.value as IdwNodalFunction)} className={inputCls}>
                        <option value="classic">Classic</option>
                        <option value="gradient">Gradient Plane</option>
                        <option value="quadratic">Quadratic</option>
                      </select>
                    </div>
                  </div>

                  <div>
                    <label className={labelCls}>Neighbors</label>
                    <div className="flex gap-2 mb-2">
                      <button onClick={() => setNeighborMode('all')} className={radioCls(neighborMode === 'all')}>
                        All Wells
                      </button>
                      <button onClick={() => setNeighborMode('nearest')} className={radioCls(neighborMode === 'nearest')}>
                        Nearest N
                      </button>
                    </div>
                    {neighborMode === 'nearest' && (
                      <div>
                        <input type="number" value={neighborCount} min={3} max={100} step={1}
                          onChange={e => setNeighborCount(Math.max(3, parseInt(e.target.value) || 12))}
                          className={inputCls} />
                        {nodalFunction === 'quadratic' && neighborCount < 6 && (
                          <p className="text-[10px] text-red-500 mt-1">Quadratic nodal function requires at least 6 neighbors</p>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* General interpolation options */}
              <div className="bg-slate-50 rounded-lg border border-slate-200 p-4 space-y-3">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide">General Options</h4>

                <div className="grid grid-cols-2 gap-4">
                  <div>
                    <label className="flex items-center gap-2 cursor-pointer mb-1">
                      <input type="checkbox" checked={truncateLow}
                        onChange={e => setTruncateLow(e.target.checked)}
                        className="w-3.5 h-3.5 rounded accent-emerald-600" />
                      <span className="text-xs text-slate-600">Truncate Low</span>
                    </label>
                    {truncateLow && (
                      <input type="number" value={truncateLowValue} step={1}
                        onChange={e => setTruncateLowValue(parseFloat(e.target.value) || 0)}
                        className={inputCls} />
                    )}
                  </div>
                  <div>
                    <label className="flex items-center gap-2 cursor-pointer mb-1">
                      <input type="checkbox" checked={truncateHigh}
                        onChange={e => setTruncateHigh(e.target.checked)}
                        className="w-3.5 h-3.5 rounded accent-emerald-600" />
                      <span className="text-xs text-slate-600">Truncate High</span>
                    </label>
                    {truncateHigh && (
                      <input type="number" value={truncateHighValue} step={1}
                        onChange={e => setTruncateHighValue(parseFloat(e.target.value) || 0)}
                        className={inputCls} />
                    )}
                  </div>
                </div>

                <div>
                  <label className="flex items-center gap-2 cursor-pointer" title={hasNonPositiveValues ? 'Cannot use log interpolation: dataset contains zero or negative values' : ''}>
                    <input type="checkbox" checked={logInterpolation}
                      disabled={hasNonPositiveValues}
                      onChange={e => setLogInterpolation(e.target.checked)}
                      className="w-3.5 h-3.5 rounded accent-emerald-600 disabled:opacity-40" />
                    <span className={`text-xs ${hasNonPositiveValues ? 'text-slate-400' : 'text-slate-600'}`}>
                      Log Interpolation
                      {hasNonPositiveValues && <span className="ml-1 text-[10px] text-amber-500">(non-positive values present)</span>}
                    </span>
                  </label>
                </div>
              </div>
            </div>
          )}

          {/* ===== STEP 4: Title & Summary ===== */}
          {step === 4 && (
            <div className="space-y-5">
              {errorMessage && (
                <div className="bg-red-50 border border-red-200 rounded-lg p-3 flex items-start gap-2">
                  <AlertTriangle size={16} className="text-red-500 mt-0.5 shrink-0" />
                  <div>
                    <p className="text-sm font-medium text-red-800">Analysis Failed</p>
                    <p className="text-xs text-red-600 mt-1">{errorMessage}</p>
                  </div>
                </div>
              )}

              <div>
                <label className={labelCls}>Title</label>
                <input type="text" value={title} onChange={e => {
                  // Only allow [a-zA-Z0-9 _-]
                  const v = e.target.value.replace(/[^a-zA-Z0-9 _-]/g, '');
                  setTitle(v);
                }}
                  placeholder="e.g. Annual Analysis 2024"
                  className={inputCls} />
                {title && (
                  <div className="mt-1 flex items-center gap-2">
                    <span className="text-[10px] text-slate-400">{slugify(aquifer.name)}/raster_{dataType.code}_{code}.json</span>
                    {hasConflict && <span className="text-[10px] text-red-500 font-medium">Name already exists</span>}
                  </div>
                )}
              </div>

              {/* Options summary */}
              <div className="bg-slate-50 rounded-lg border border-slate-200 p-4">
                <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wide mb-3">Options Summary</h4>
                <div className="grid grid-cols-2 gap-x-6 gap-y-1 text-xs text-slate-600">
                  <div><span className="text-slate-400">Maps:</span> {mapCount}, {MONTH_NAMES[month - 1]} {startYear} to {MONTH_NAMES[month - 1]} {endYear}</div>
                  <div><span className="text-slate-400">Interval:</span> {INTERVAL_LABELS[interval]}</div>
                  <div><span className="text-slate-400">Data:</span> {dataSource === 'model' ? `Imputed Data (${availableModels?.find(m => m.code === selectedModelCode)?.title ?? selectedModelCode})` : 'Measurements'}</div>
                  <div><span className="text-slate-400">Temporal:</span> {
                    smoothingMethod === 'pchip' ? 'PCHIP' :
                    smoothingMethod === 'model-direct' ? 'Direct' :
                    `Moving Average, ${smoothingMonths} months`
                  }</div>
                  {dataSource !== 'model' && (
                    <>
                      <div><span className="text-slate-400">Wells:</span> {qualifiedWellCount}, with {minObs}+ readings over {minSpanYears}+ years</div>
                      <div><span className="text-slate-400">First and last readings:</span> {hold ? `held up to ${holdYears} years` : 'not held'}</div>
                    </>
                  )}
                  {dataSource === 'model' && (
                    <div><span className="text-slate-400">Wells:</span> {mapIds.size}, the model's</div>
                  )}
                  <div><span className="text-slate-400">Resolution:</span> {resolution} columns</div>
                  <div><span className="text-slate-400">Method:</span> {spatialMethod === 'kriging' ? `Kriging (${variogramModel})` : `IDW (p=${idwExponent})`}</div>
                  {spatialMethod === 'kriging' && (
                    <>
                      <div><span className="text-slate-400">Nugget:</span> {nuggetEnabled ? 'Yes' : 'No'}</div>
                      <div><span className="text-slate-400">Range:</span> {rangeMode === 'auto' ? 'Auto' : rangeMode === 'custom' ? `${rangeValue}m` : `${rangeValue}%`}</div>
                    </>
                  )}
                  {spatialMethod === 'idw' && (
                    <>
                      <div><span className="text-slate-400">Nodal:</span> {nodalFunction}</div>
                      <div><span className="text-slate-400">Neighbors:</span> {neighborMode === 'all' ? 'All' : `Nearest ${neighborCount}`}</div>
                    </>
                  )}
                  {(truncateLow || truncateHigh || logInterpolation) && (
                    <div className="col-span-2 mt-1 pt-1 border-t border-slate-200">
                      <span className="text-slate-400">Post-processing:</span>{' '}
                      {[
                        truncateLow && `low >= ${truncateLowValue}`,
                        truncateHigh && `high <= ${truncateHighValue}`,
                        logInterpolation && 'log transform',
                      ].filter(Boolean).join(', ')}
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* ===== RUNNING ===== */}
          {step === 'running' && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <Loader2 className="w-10 h-10 text-emerald-500 animate-spin" />
              <p className="text-sm text-slate-600">{progressText}</p>
              <div className="w-80 bg-slate-200 rounded-full h-2.5">
                <div className="bg-emerald-500 h-2.5 rounded-full transition-all duration-300"
                  style={{ width: `${progressPct}%` }} />
              </div>
              <p className="text-xs text-slate-400">{Math.round(progressPct)}%</p>
            </div>
          )}

          {/* ===== COMPLETE ===== */}
          {step === 'complete' && result && (
            <div className="flex flex-col items-center justify-center py-12 space-y-4">
              <CheckCircle2 className="w-12 h-12 text-emerald-500" />
              <h3 className="text-lg font-semibold text-slate-800">Analysis Complete</h3>
              <div className="text-sm text-slate-600 text-center space-y-1">
                <p>{result.frames.length} timesteps &bull; {result.params.startDate} to {result.params.endDate}</p>
                <p>{result.aquiferName}</p>
              </div>
              {result.options?.places && (
                <p className="text-xs text-slate-500 text-center max-w-sm">
                  {result.options.places.places} place{result.options.places.places !== 1 ? 's' : ''} had more than one well
                  within {result.options.places.meters} m. The map used one well at each and left
                  out {result.options.places.leftOut.length}.
                </p>
              )}
              {result.colocated && result.colocated.places > 0 && (
                <p className="text-xs text-slate-500 text-center max-w-sm">
                  {result.colocated.wells} wells at {result.colocated.places} place{result.colocated.places !== 1 ? 's' : ''} were
                  within {result.options?.places?.meters ?? COLOCATED_METERS} m of each other. Each place is one point in the map, with
                  the average of its wells' values.
                </p>
              )}
            </div>
          )}
        </div>

        {/* Footer */}
        <div className="flex items-center justify-between px-6 py-3 border-t border-slate-200 bg-slate-50">
          {/* Left: Cancel */}
          <div>
            {(stepNumber || step === 'running') && (
              <button onClick={step === 'running' ? handleCancel : onClose}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                Cancel
              </button>
            )}
          </div>

          {/* Center: Back */}
          <div>
            {stepNumber && stepNumber > 1 && (
              <button onClick={() => setStep(stepNumber === 3 && !hasPlaceStep ? 1 : (stepNumber - 1) as Step)}
                className="flex items-center gap-1 px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                <ChevronLeft size={16} />
                Back
              </button>
            )}
          </div>

          {/* Right: Next / Run / View */}
          <div>
            {step === 1 && (
              <button onClick={() => setStep(hasPlaceStep ? 2 : 3)} disabled={!step1Valid}
                className="flex items-center gap-1 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Next
                <ChevronRight size={16} />
              </button>
            )}
            {step === 2 && (
              <button onClick={() => setStep(3)} disabled={!(placeMeters > 0) || (places.length > 0 && placesLoading)}
                className="flex items-center gap-1 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Next
                <ChevronRight size={16} />
              </button>
            )}
            {step === 3 && (
              <button onClick={() => {
                  if (!title) {
                    const defaultTitle = spatialMethod === 'kriging' ? 'kriging'
                      : nodalFunction === 'classic' ? 'idw'
                      : nodalFunction === 'gradient' ? 'idw_gp'
                      : 'idw_quad';
                    setTitle(defaultTitle);
                  }
                  setStep(4);
                }} disabled={!spatialValid}
                className="flex items-center gap-1 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                Next
                <ChevronRight size={16} />
              </button>
            )}
            {step === 4 && (
              <button onClick={handleRun} disabled={!titleValid}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors disabled:opacity-50 disabled:cursor-not-allowed">
                <Play size={16} />
                Run Analysis
              </button>
            )}
            {step === 'running' && (
              <div /> /* Cancel is on the left */
            )}
            {step === 'complete' && result && (
              <button onClick={() => onComplete(result)}
                className="flex items-center gap-2 px-4 py-2 bg-emerald-600 text-white text-sm font-medium rounded-lg hover:bg-emerald-700 transition-colors">
                View Results
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SpatialAnalysisDialog;
