# AquiferX

**AquiferX** is a web-based groundwater data visualization and analysis application. It provides a complete toolkit for loading, exploring, and analyzing groundwater monitoring data — from raw well measurements to spatial interpolation, trend analysis, and machine-learning-based data imputation.

<!-- screenshot: Main application interface showing map with wells, sidebar, and time series chart -->

## Key Features

- **Interactive Map** — Explore well locations on a Leaflet map with multiple basemap options. Click wells to view time series; shift-click or box-drag to select multiple wells for comparison.

- **Time Series Visualization** — View measurement history with smooth PCHIP interpolation curves. Edit individual measurements, zoom into date ranges, and overlay ground surface elevations.

- **Hub-and-Spoke Data Management** — Import regions, aquifer boundaries, well locations, and measurements through guided wizards. Supports CSV, GeoJSON, and shapefile formats with automatic CRS reprojection.

- **USGS Integration** — Download well locations and water-level measurements directly from the USGS Water Data API for any region overlapping the United States.

- **Trend Analysis** — Compute linear regression trends for every well and aquifer, with color-coded map markers indicating the rate of water-level change.

- **Spatial Analysis** — Interpolate well data across an aquifer using Kriging or Inverse Distance Weighting (IDW). Animate raster surfaces over time, draw cross sections, and compute storage volume changes.

- **Data Imputation** — Fill gaps in sparse measurement records using Extreme Learning Machines (ELM) trained on GLDAS climate variables, with PCHIP interpolation for measured intervals.

- **Custom Data Types** — Define and manage custom measurement types (e.g., salinity, pH) beyond the default water table elevation (WTE).

## Who Is This For?

AquiferX is designed for hydrogeologists, water resource engineers, researchers, and students who work with groundwater monitoring data. Whether you are managing a regional monitoring network, conducting aquifer characterization, or teaching groundwater concepts, AquiferX provides an accessible, browser-based interface for common analysis workflows.

## Getting Started

Ready to dive in? Head to the [Getting Started](getting-started.md) guide to install the app and load your first dataset. For a broader overview of the app's interface and capabilities, see the [Overview](overview.md) page.

## License

AquiferX is released under the [MIT License](../LICENSE).
