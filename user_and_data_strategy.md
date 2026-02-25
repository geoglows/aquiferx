# Aquifer Analyst — User & Data Management Strategy

## Executive Summary

The Aquifer Analyst is a groundwater data visualization and analysis tool within the [GEOGLOWS](https://dev.apps.geoglows.org/) web application suite. Users worldwide upload regional groundwater data — region boundaries, aquifer boundaries, wells, and measurements — for interactive mapping, time series analysis, and storage change estimation.

The app currently runs as a local-only prototype with no user accounts, no remote data storage, and no access control. This document defines the strategy to evolve it into a multi-user cloud application while preserving a fully offline mode for organizations that cannot share data externally.

### Goals

- **User accounts and engagement tracking** across all GEOGLOWS apps via a shared authentication system.
- **Organization-based access control** with admin (read/write) and viewer (read-only) roles.
- **Cloud data persistence** so users can revisit and manage their data across sessions.
- **Public and private visibility** — organizations choose whether their regions are publicly accessible or restricted to members.
- **Air-gapped / local-only mode** for organizations that treat groundwater data as confidential. Data never leaves the browser.
- **Sample regions** that new users can explore immediately to understand the app's capabilities.
- **Concurrent editing safety** via optimistic locking to prevent data loss when multiple admins work simultaneously.

### Approach

The recommended stack is **Supabase** (authentication, Postgres database, file storage) and **Vercel** (hosting, serverless API routes, GitHub CI/CD). Both offer generous free tiers and scale affordably. Supabase is open-source and can be self-hosted if institutional requirements demand it.

The core architectural change is a **Data Provider abstraction layer** — a TypeScript interface that all components use instead of calling APIs directly. Two implementations back this interface: a `SupabaseDataProvider` for cloud mode and a `LocalDataProvider` (IndexedDB) for air-gapped mode. This allows the entire visualization and analysis layer to remain unchanged regardless of where data lives.

Implementation is organized into **7 phases**: (1) data abstraction layer, (2) Supabase setup, (3) authentication and user management, (4) cloud data operations, (5) Vercel deployment, (6) local/air-gapped mode, (7) public access and sample regions.

---

## Table of Contents

1. [Technology Stack](#1-technology-stack)
2. [Use Cases & Access Patterns](#2-use-cases--access-patterns)
3. [App Modes & Entry Flow](#3-app-modes--entry-flow)
4. [Database Schema](#4-database-schema)
5. [Row-Level Security (RLS)](#5-row-level-security-rls)
6. [Data Provider Abstraction Layer](#6-data-provider-abstraction-layer)
7. [Organization & Permissions](#7-organization--permissions)
8. [Optimistic Locking (Concurrency)](#8-optimistic-locking-concurrency)
9. [Vercel API Routes](#9-vercel-api-routes)
10. [Sample Regions](#10-sample-regions)
11. [Implementation Phases](#11-implementation-phases)
12. [What Changes and What Doesn't](#12-what-changes-and-what-doesnt)

---

## 1. Technology Stack

| Layer | Technology | Cost |
|---|---|---|
| Frontend | React 19 + Vite 6 (current) | Free |
| Hosting | Vercel | Free (hobby) / $20/mo (pro) |
| Auth + DB + Storage | Supabase | Free tier / $25/mo (pro) |
| Repo + CI/CD | GitHub → Vercel auto-deploy | Free |

### Why Supabase

- **Free tier is generous** — 50K monthly active users, 500MB database, 1GB storage.
- **Auth is built in** — Google, GitHub, email/password, and SAML/SSO for institutional logins. No separate service to manage.
- **Postgres database** — Real SQL with Row-Level Security (RLS) policies. Permissions are enforced at the database level, not just in application code.
- **Shared across GEOGLOWS apps** — One Supabase project can serve all apps in the suite. Users log in once, same account works across Aquifer Analyst and the other apps.
- **Storage bucket** — For GeoJSON files, shapefiles, and other binary uploads that don't belong in Postgres tables.
- **Real-time subscriptions** — Built-in support for "someone else just imported new data" notifications if needed in the future.
- **Open source** — If GEOGLOWS ever needs to self-host (university IT requirements, etc.), Supabase can be deployed on your own infrastructure.

### Why Vercel

- Automatic deployments on every push to `main` via GitHub integration.
- Every pull request gets a preview deployment with a unique URL for testing.
- Build settings auto-detect Vite projects — near-zero configuration.
- Serverless API routes (`api/` directory) replace the current Vite dev server middleware.
- Environment variables managed in the Vercel dashboard (Supabase keys, etc.).
- Free hobby tier for development; Pro ($20/mo) for production.

---

## 2. Use Cases & Access Patterns

| Pattern | Auth Required | Data Location | Visibility |
|---|---|---|---|
| **Public viewer** | None | Cloud (Supabase) | Read-only, anyone with the URL |
| **Org viewer** | Login | Cloud (Supabase) | Read-only, org members only |
| **Org admin** | Login | Cloud (Supabase) | Read/write, org members only |
| **Public org** | Login (admins) | Cloud (Supabase) | Admins manage, public can view |
| **Air-gapped / local-only** | None | Browser only (IndexedDB) | Never leaves the machine |

### Air-Gapped Use Case

Some organizations consider groundwater data to be a state secret. They will not upload data to any remote server. For these users:

- The app runs entirely in the browser. No data is transmitted over the network.
- Users upload a zip file containing their region data. It is loaded into IndexedDB (browser-local storage).
- All visualization and analysis features work identically to cloud mode.
- Users can export their data back as a zip file when done.
- When the browser tab closes, the data can be cleared (with a warning).

---

## 3. App Modes & Entry Flow

```
User visits app
  │
  ├─→ "Sign In" → Supabase Auth → Cloud Mode
  │     ├─→ Dashboard: your orgs, your regions
  │     ├─→ Create org, invite members
  │     ├─→ Import data (writes to Supabase)
  │     └─→ View public regions (no org required)
  │
  ├─→ "Use Locally" → Local Mode (Air-Gapped)
  │     ├─→ Upload zip file → IndexedDB
  │     ├─→ Full app functionality (view, analyze, import)
  │     ├─→ Export zip when done
  │     └─→ Data never leaves the browser
  │
  └─→ "Explore Sample Data" → Read-Only Cloud Mode (no login)
        └─→ Browse pre-loaded demo regions
```

---

## 4. Database Schema

### Supabase Postgres

```sql
-- Users (managed by Supabase Auth; this extends auth.users)
CREATE TABLE public.profiles (
    id          uuid PRIMARY KEY REFERENCES auth.users(id),
    email       text NOT NULL,
    display_name text,
    created_at  timestamptz DEFAULT now()
);

-- Organizations
CREATE TABLE public.organizations (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    slug        text NOT NULL UNIQUE,  -- URL-safe identifier
    created_by  uuid REFERENCES public.profiles(id),
    created_at  timestamptz DEFAULT now()
);

-- Organization memberships
CREATE TABLE public.org_memberships (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
    user_id     uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('admin', 'viewer')),
    invited_at  timestamptz DEFAULT now(),
    accepted_at timestamptz,
    UNIQUE (org_id, user_id)
);

-- Regions
CREATE TABLE public.regions (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    org_id      uuid REFERENCES public.organizations(id) ON DELETE CASCADE,  -- nullable for sample regions
    slug        text NOT NULL,
    name        text NOT NULL,
    length_unit text NOT NULL CHECK (length_unit IN ('ft', 'm')),
    single_unit boolean NOT NULL DEFAULT false,
    visibility  text NOT NULL DEFAULT 'private' CHECK (visibility IN ('private', 'public')),
    version     integer NOT NULL DEFAULT 1,  -- optimistic locking
    boundary    jsonb,                        -- GeoJSON geometry
    is_sample   boolean NOT NULL DEFAULT false,
    created_at  timestamptz DEFAULT now(),
    updated_at  timestamptz DEFAULT now(),
    UNIQUE (org_id, slug)
);

-- Data types (per region)
CREATE TABLE public.data_types (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
    code        varchar(20) NOT NULL,
    name        text NOT NULL,
    unit        text NOT NULL,
    UNIQUE (region_id, code)
);

-- Aquifers
CREATE TABLE public.aquifers (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
    aquifer_id  text NOT NULL,      -- user-facing ID ("0", "1", etc.)
    aquifer_name text NOT NULL,
    boundary    jsonb,              -- GeoJSON geometry
    UNIQUE (region_id, aquifer_id)
);

-- Wells
CREATE TABLE public.wells (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
    aquifer_id  uuid REFERENCES public.aquifers(id) ON DELETE SET NULL,
    well_id     text NOT NULL,      -- user-facing ID
    well_name   text,
    lat         double precision NOT NULL,
    long        double precision NOT NULL,
    gse         double precision,   -- ground surface elevation
    created_at  timestamptz DEFAULT now(),
    UNIQUE (region_id, well_id)
);

-- Measurements
CREATE TABLE public.measurements (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
    well_id     uuid NOT NULL REFERENCES public.wells(id) ON DELETE CASCADE,
    data_type   varchar(20) NOT NULL,
    date        date NOT NULL,
    value       double precision NOT NULL
);
CREATE INDEX idx_measurements_lookup
    ON public.measurements (region_id, well_id, data_type, date);

-- Storage analyses
CREATE TABLE public.storage_analyses (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    region_id   uuid NOT NULL REFERENCES public.regions(id) ON DELETE CASCADE,
    aquifer_id  uuid REFERENCES public.aquifers(id) ON DELETE CASCADE,
    title       text NOT NULL,
    code        text NOT NULL,
    params      jsonb NOT NULL,
    result_data jsonb NOT NULL,     -- grids, frames, etc.
    created_at  timestamptz DEFAULT now()
);

-- Sample region templates (for the "Explore Sample Data" feature)
CREATE TABLE public.sample_region_templates (
    id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    name        text NOT NULL,
    description text,
    thumbnail_url text,
    bundle_path text NOT NULL,      -- path in Supabase Storage to the zip
    created_at  timestamptz DEFAULT now()
);
```

---

## 5. Row-Level Security (RLS)

All tables have RLS enabled. Core policies:

### Regions

```sql
-- Anyone can read public regions and sample regions
CREATE POLICY "Public regions are visible to all"
    ON public.regions FOR SELECT
    USING (visibility = 'public' OR is_sample = true);

-- Org members can read their org's private regions
CREATE POLICY "Org members can view private regions"
    ON public.regions FOR SELECT
    USING (org_id IN (
        SELECT org_id FROM public.org_memberships
        WHERE user_id = auth.uid()
    ));

-- Only org admins can write
CREATE POLICY "Org admins can modify regions"
    ON public.regions FOR ALL
    USING (org_id IN (
        SELECT org_id FROM public.org_memberships
        WHERE user_id = auth.uid() AND role = 'admin'
    ));
```

### Child Tables (aquifers, wells, measurements, data_types, storage_analyses)

All inherit access from their parent region:

```sql
-- Read: allowed if the parent region is readable
CREATE POLICY "Readable if region is readable"
    ON public.wells FOR SELECT
    USING (region_id IN (
        SELECT id FROM public.regions
        WHERE visibility = 'public'
           OR is_sample = true
           OR org_id IN (
               SELECT org_id FROM public.org_memberships
               WHERE user_id = auth.uid()
           )
    ));

-- Write: allowed if user is admin of the parent region's org
CREATE POLICY "Writable if org admin"
    ON public.wells FOR ALL
    USING (region_id IN (
        SELECT r.id FROM public.regions r
        JOIN public.org_memberships m ON m.org_id = r.org_id
        WHERE m.user_id = auth.uid() AND m.role = 'admin'
    ));
```

The same pattern applies to all child tables.

---

## 6. Data Provider Abstraction Layer

The abstraction layer is the key architectural piece that enables both cloud and local modes. Components never call Supabase or fetch APIs directly — they go through a provider interface.

### Interface

```typescript
interface DataProvider {
  // Regions
  listRegions(): Promise<RegionMeta[]>;
  getRegion(id: string): Promise<Region>;
  saveRegion(region: RegionInput): Promise<Region>;
  deleteRegion(id: string): Promise<void>;

  // Aquifers
  getAquifers(regionId: string): Promise<Aquifer[]>;
  saveAquifers(regionId: string, aquifers: AquiferInput[], mode: 'append' | 'replace'): Promise<void>;

  // Wells
  getWells(regionId: string): Promise<Well[]>;
  saveWells(regionId: string, wells: WellInput[], mode: 'append' | 'replace'): Promise<void>;

  // Measurements
  getMeasurements(regionId: string, dataType: string): Promise<Measurement[]>;
  saveMeasurements(regionId: string, dataType: string, data: MeasurementInput[], mode: 'append' | 'replace'): Promise<void>;
  updateMeasurement(id: string, value: number): Promise<void>;
  deleteMeasurement(id: string): Promise<void>;

  // Storage analyses
  listStorageAnalyses(regionId: string): Promise<StorageAnalysisMeta[]>;
  getStorageAnalysis(id: string): Promise<StorageAnalysisResult>;
  saveStorageAnalysis(regionId: string, result: StorageAnalysisResult): Promise<void>;
  deleteStorageAnalysis(id: string): Promise<void>;

  // GeoJSON boundaries
  getRegionBoundary(regionId: string): Promise<GeoJSON.FeatureCollection>;
  getAquiferBoundaries(regionId: string): Promise<GeoJSON.FeatureCollection>;

  // Data types
  getDataTypes(regionId: string): Promise<DataType[]>;
  saveDataType(regionId: string, dataType: DataType): Promise<void>;
  deleteDataType(regionId: string, code: string): Promise<void>;

  // Version (optimistic locking)
  getRegionVersion(regionId: string): Promise<number>;

  // Sample regions (cloud only, optional)
  listSampleRegions?(): Promise<SampleRegionTemplate[]>;
  importSampleRegion?(templateId: string, targetOrgId: string): Promise<Region>;
}
```

### Implementations

1. **`SupabaseDataProvider`** — Reads and writes to Supabase Postgres via the Supabase JS client SDK. Used when the user is logged in (cloud mode).

2. **`LocalDataProvider`** — Reads and writes to IndexedDB in the browser. Used in air-gapped/local mode. Data is loaded from the user's uploaded zip file and stored in IndexedDB for the duration of the session.

### React Integration

```typescript
// Context provides the active data provider
const DataProviderContext = createContext<DataProvider>(null);

// Hook used by all components
function useDataProvider(): DataProvider {
  return useContext(DataProviderContext);
}

// App root selects the provider based on mode
function App() {
  const [mode, setMode] = useState<'cloud' | 'local' | null>(null);
  const provider = mode === 'cloud'
    ? new SupabaseDataProvider(supabaseClient)
    : new LocalDataProvider();

  return (
    <DataProviderContext.Provider value={provider}>
      {/* ... */}
    </DataProviderContext.Provider>
  );
}
```

---

## 7. Organization & Permissions

### Self-Service Organization Creation

1. User signs up or logs in via Supabase Auth.
2. User clicks "Create Organization" → enters a name.
3. A URL-safe slug is auto-generated from the name.
4. The user is automatically assigned as the first admin.
5. The user can invite others via email.
6. Invitees receive an email link → create account (or link existing) → join as viewer or admin (the inviter chooses the role).

### Permission Matrix

| Action | Required Role |
|---|---|
| View public region | No login required |
| View sample region | No login required |
| View private region | Org member (admin or viewer) |
| Import / edit / delete data | Org admin |
| Create storage analysis | Org admin |
| Create organization | Any logged-in user |
| Invite members | Org admin |
| Change member roles | Org admin |
| Remove members | Org admin |
| Delete organization | Org admin (with confirmation) |
| Change region visibility | Org admin |
| Manage sample templates | GEOGLOWS super-admin |

### UI Changes

- **Header**: Shows user avatar/name and org selector dropdown when logged in.
- **Sidebar**: Regions grouped by org, with a "Public" section for public regions and a "Samples" section for demo data.
- **Import hub**: Only accessible to org admins. Org selector determines where imported data goes.
- **Read-only indicators**: Viewers see a lock icon or "View Only" badge. Edit/import buttons are hidden.

---

## 8. Optimistic Locking (Concurrency)

Concurrent editing within an organization is expected to be rare, so optimistic locking is sufficient.

### How It Works

1. Client loads a region → receives `version: 5`.
2. Client makes edits, sends a save request including `version: 5`.
3. Server checks: if the current DB version is still `5`, the save succeeds → version becomes `6`.
4. If another admin saved first (version is now `6`), the request fails with a conflict error.
5. Client shows: *"This region was modified by another user. Reload to see their changes?"*

### Scope

Optimistic locking applies at the **region level** for all write operations:

- Importing aquifers, wells, or measurements
- Editing individual measurements (DataEditor)
- Creating or deleting storage analyses
- Changing region settings (name, visibility, data types)

---

## 9. Vercel API Routes

The current Vite dev server middleware (`vite.config.ts` plugin) is replaced with Vercel serverless functions in the `api/` directory.

```
api/
  ├── auth/
  │   └── callback.ts              # Supabase auth callback handler
  │
  ├── regions/
  │   ├── index.ts                 # GET: list regions; POST: create region
  │   └── [id].ts                  # GET: single region; PUT: update; DELETE: delete
  │
  ├── regions/[id]/
  │   ├── aquifers.ts              # GET: list; POST: save aquifers
  │   ├── wells.ts                 # GET: list; POST: save wells
  │   ├── measurements.ts          # GET: list by data type; POST: save measurements
  │   ├── data-types.ts            # GET: list; POST: add; DELETE: remove
  │   └── storage.ts               # GET: list analyses; POST: save analysis
  │
  ├── orgs/
  │   ├── index.ts                 # GET: my orgs; POST: create org
  │   ├── [id].ts                  # GET: org details; PUT: update; DELETE: delete
  │   └── [id]/
  │       └── members.ts           # GET: list; POST: invite; DELETE: remove
  │
  └── samples/
      ├── index.ts                 # GET: list sample templates
      └── [id]/
          └── import.ts            # POST: copy sample into user's org
```

Each route:
1. Extracts the Supabase JWT from the `Authorization` header.
2. Creates a Supabase server client scoped to that user.
3. Performs the database operation with RLS automatically enforced.
4. Returns JSON responses.

---

## 10. Sample Regions

Sample regions allow new users to explore the app immediately without uploading their own data.

### How It Works

- Sample region templates are stored in **Supabase Storage** as zip bundles (same format as the current region folder structure: `region.json`, `region.geojson`, `aquifers.geojson`, `wells.csv`, `data_*.csv`).
- A `sample_region_templates` table stores metadata: name, description, thumbnail URL.
- The app shows a **"Sample Data"** section accessible without login. Users can browse and explore these regions in read-only mode.
- Logged-in users get an **"Import Sample Region"** button that copies a template into their org as a real, editable region.
- In **local mode**, sample regions are downloadable as zip files that the user can then upload.

### Initial Migration

The 9 existing regions in `public/data/` become the initial set of sample region templates:
- dominican-republic
- great-salt-lake-basin
- guam
- jamaica
- jordan
- niger
- oregon
- utah
- volta-basin

### Management

A GEOGLOWS super-admin (identified by a flag on their user profile or membership in a special "geoglows" organization) can:
- Upload new sample region templates
- Edit template metadata (name, description, thumbnail)
- Remove sample templates

---

## 11. Implementation Phases

### Phase 1 — Data Abstraction Layer

*No user-visible changes. Purely architectural preparation.*

- Define the `DataProvider` interface in TypeScript.
- Implement `LocalDataProvider` backed by the current Vite middleware (flat files on disk).
- Create `DataProviderContext` and `useDataProvider()` hook.
- Refactor all components to use the provider instead of direct `fetch()` / API calls:
  - `App.tsx` (data loading, refresh)
  - `ImportDataHub.tsx` and all sub-wizards
  - `DataEditor.tsx`
  - `StorageAnalysisDialog.tsx`
  - `Sidebar.tsx` (delete operations)
- All existing functionality must continue to work identically after this phase.

### Phase 2 — Supabase Setup & Database Schema

*Infrastructure only. No app changes yet.*

- Create Supabase project.
- Apply database schema (all tables, indexes, constraints from Section 4).
- Write and test RLS policies (Section 5).
- Set up Supabase Storage bucket for GeoJSON and zip files.
- Configure auth providers (email/password, Google; optionally ORCID for academic users).
- Package the 9 existing regions as sample region templates and upload to Supabase Storage.

### Phase 3 — Authentication & User Management

*First user-visible change.*

- Add Supabase Auth client SDK to the app.
- Build login / signup pages (email + social provider buttons).
- Build the **landing page** with three entry points: Sign In, Use Locally, Explore Samples.
- Add auth state to React context (current user, current org, org list).
- Build organization creation UI.
- Build member invitation and role management UI.
- Update the header: user menu, org selector dropdown.
- Gate the Import Data hub behind admin role check.

### Phase 4 — Cloud Data Provider

*The big migration — cloud read/write.*

- Implement `SupabaseDataProvider` with all CRUD operations against Postgres.
- Wire up the import system (ImportDataHub, all sub-wizards) to use the provider.
- Implement optimistic locking on all save operations.
- Adapt DataEditor for cloud save (individual measurement edit/delete).
- Adapt StorageAnalysisDialog for cloud save.
- Handle large measurement datasets (pagination or streaming for regions with 100K+ rows).
- Test the full import → visualize → analyze flow end-to-end.

### Phase 5 — Vercel Deployment

*Go live.*

- Create Vercel project linked to the GitHub repo.
- Implement serverless API routes in `api/` (Section 9) for any operations that require server-side logic.
- Configure environment variables in Vercel dashboard (Supabase URL, anon key, service role key).
- Set up preview deployments for pull requests.
- DNS / domain configuration for the production URL.
- Remove the Vite dev server middleware plugin (no longer needed in production).
- Verify the full flow in the deployed environment.

### Phase 6 — Local / Air-Gapped Mode

*Complete the second data path.*

- Implement `IndexedDBDataProvider` (reads/writes to browser IndexedDB).
- Build the **zip upload flow**: user selects a zip → parsed in-browser → stored in IndexedDB.
- Build the **zip export flow**: serialize IndexedDB contents back to the standard zip format.
- Ensure all visualization and analysis features work in local mode (MapView, charts, storage analysis, cross-sections).
- Ensure **zero network requests** in local mode (verify with browser network tab).
- Session management: warn user before closing the tab if they have unsaved data. Provide a "Clear Data" action.

### Phase 7 — Public Access, Sharing & Sample Regions

*Polish and complete the access model.*

- Add region **visibility toggle** in region settings (admin only): private ↔ public.
- Implement **public URL scheme**: `/public/{org-slug}/{region-slug}` — accessible without login.
- Wire up unauthenticated read path through the Supabase provider (anon key + RLS policies for public regions).
- Build the **sample regions gallery** UI: grid of cards with thumbnails, names, descriptions.
- Implement "Import Sample Region" flow: copy template data into the user's selected org.
- Build the **admin interface** for managing sample templates (upload zip, edit metadata, delete).

---

## 12. What Changes and What Doesn't

### Unchanged

These components and systems remain as they are today:

- **Visualization**: MapView, TimeSeriesChart, StorageOverlay, CrossSectionChart, DataEditor
- **Import wizard UI/UX**: ImportDataHub, RegionImporter, AquiferImporter, WellImporter, MeasurementImporter, DataTypeEditor, ColumnMapperModal, ConfirmDialog
- **Data formats**: CSV, GeoJSON, region.json — still used for import, export, local mode, and sample region bundles
- **Client-side computation**: Kriging, storage analysis, PCHIP interpolation, trend analysis, CRS reprojection
- **Services**: usgsApi.ts, kriging.ts, storageAnalysis.ts, reprojection.ts

### Changed

- **Data access**: All components read/write through the `DataProvider` interface instead of direct API calls.
- **App entry point**: New landing page with mode selection (Sign In / Use Locally / Explore Samples).
- **Header**: User avatar, org selector, login/logout controls.
- **Sidebar**: Regions grouped by org. Permission-aware (edit controls hidden for viewers).
- **Import hub**: Org-scoped — data imports go into the selected org's region. Accessible only to org admins.
- **Data loading**: `loadAllData()` replaced by provider calls. No more full-reload refresh — incremental updates where possible.
- **Hosting**: Vite dev server middleware → Vercel serverless functions for production. Vite middleware retained for local development.
