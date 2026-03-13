# Viewing Data

Once data is loaded into AquiferX, you can explore it through the sidebar tree, interactive map, and time series chart.

## Sidebar Navigation

The sidebar on the left shows a hierarchical tree of your data:

<!-- screenshot: Sidebar showing expanded region with aquifers and wells -->

- **Regions** — Click to select. An eye icon toggles the region boundary visibility on the map.
- **Aquifers** — Expand a region to see its aquifers. Click an aquifer to display its wells on the map.
- **Wells** — Listed under each aquifer with a count badge. Click a well to view its time series.

### Context Menus

Right-click on a region or aquifer to access additional actions:

- **Edit** — Modify region name, length unit, or single-unit setting.
- **Rename** — Rename a region or aquifer.
- **Download** — Export the region as a ZIP file.
- **Delete** — Remove the item (with confirmation).

### Raster Analyses

Below the well list, the sidebar shows any computed raster analyses for the selected aquifer. Click a raster to load it as an overlay on the map. You can also rename, delete, or view info about each raster.

### Imputation Models

Similarly, any imputation models for the selected aquifer are listed. Click a model to load its results into the time series chart.

## Interactive Map

The center of the app displays an interactive Leaflet map.

<!-- screenshot: Map showing wells on satellite imagery with region boundary -->

### Basemaps

Click the basemap selector in the map controls to choose from eight options:

| Basemap | Description |
|---------|-------------|
| OpenStreetMap | Standard open-source street map |
| Esri Topographic | Detailed topographic features |
| Esri Imagery | Satellite and aerial imagery |
| Esri Streets | Simplified street map |
| Esri Light Gray | Minimal gray canvas |
| Esri Dark Gray | Dark-themed canvas |
| Esri Terrain | Hillshade and land cover |

Each basemap shows a thumbnail preview in the selector.

### Well Markers

Wells appear as circles on the map. Their color reflects the number of available measurements for the currently selected data type — lighter colors indicate fewer measurements, darker colors indicate more. A minimum observation threshold filter (in the toolbar) lets you hide wells with too few measurements.

### Date Filter

The **Filter dates** toggle in the map options panel lets you show only wells whose measurement date range overlaps a specified time window. When enabled, two year inputs appear for the minimum and maximum year. The min year defaults to the earliest measurement year in the data, and the max year defaults to the current year.

A well passes the filter if its measurement span (earliest to latest) overlaps the filter range — the well does not need to have a measurement that falls directly within the range. For example, a well with measurements in 2000 and 2008 would pass a 2002–2005 filter because its span covers that period.

The filter updates only after you enter a full 4-digit year, so typing intermediate digits does not cause wells to flicker on and off. When the date filter is active and you select a well, the time series chart displays a gray shaded band over the filter range for visual reference.

### Labels

Toggle aquifer labels and well labels using the controls in the toolbar. Labels can show the well ID or name, and you can adjust the font size (9–16px).

## Well Search

When an aquifer is selected, a search bar appears in the top-left corner of the map. Type a well name or ID to filter matching wells — up to 8 results appear in a dropdown. Use the <kbd>Arrow</kbd> keys to navigate the list and <kbd>Enter</kbd> to select, or click a result directly. Press <kbd>Escape</kbd> to dismiss the search.

Selecting a well from the search results flies the map to that well's location and briefly highlights it with a shrinking red ring animation.

## Well Selection

AquiferX supports several ways to select wells for viewing in the time series chart.

### Single Selection

Click a well on the map or in the sidebar. The well is highlighted and its time series appears in the chart.

### Multi-Well Selection

- **Shift + Click** — Hold <kbd>Shift</kbd> and click a well to add it to (or remove it from) the current selection.
- **Shift + Drag** — Hold <kbd>Shift</kbd> and drag a rectangle on the map to select all wells within the box.

<!-- screenshot: Map showing box-drag selection with crosshair cursor and gold-ringed selected wells -->

Selected wells display a **gold ring** around their marker. During box-drag selection, the cursor changes to a crosshair.

### Multi-Well Chart

When multiple wells are selected, the time series chart shows each well as a separate color-coded line (from an 8-color palette). The legend identifies each well by name.

## Time Series Chart

The chart panel below the map shows measurement data for the selected well(s).

<!-- screenshot: Time series chart with PCHIP curve and measurement dots -->

### Interpolation

By default, the chart draws a smooth **PCHIP** (Piecewise Cubic Hermite Interpolating Polynomial) curve through the measurement points. PCHIP preserves monotonicity — it produces a smooth line that does not overshoot between data points, unlike simple cubic spline interpolation. A total of 100 interpolated points are generated per well to create the smooth curve.

You can switch to **Linear** interpolation, which draws straight lines between consecutive measurements.

### Measurement Dots

Actual measurement data points appear as dots on the curve. These are the real recorded values, while the line between them is interpolated. Each well's measurements appear with a distinct color matching its line.

### Ground Surface Elevation (GSE)

If the selected well has a ground surface elevation value, you can enable a **GSE overlay** — a brown dashed reference line showing the land surface level. This is useful for understanding how close the water table is to the surface.

### Trend Lines

When enabled, a linear regression trend line is computed for each selected well (requires at least 3 measurements). You can set a **Trend Window** start date to compute trends only over a recent period.

### Smoothing

An optional kernel smoothing overlay applies a **Nadaraya-Watson** Gaussian kernel to the measurement data, with a configurable smoothing window in months. This helps visualize long-term trends by dampening short-term fluctuations.

### Zoom and Pan

- **Drag to zoom** — Click and drag horizontally across the chart to zoom into a date range.
- **Reset zoom** — Double-click the chart or use the reset button to return to the full date range.
- The Y-axis auto-scales to fit the visible data.

### Measurement Editing

Click a measurement dot to select it. Right-click (or use the context menu) to:

- **Edit** — Change the measurement value.
- **Delete** — Remove the measurement from the dataset.

Edits are saved directly to the corresponding `data_{code}.csv` file.

### Export CSV

Click the **Export CSV** button in the toolbar to download the currently displayed time series data (including interpolated points) as a CSV file.

### Expanded Chart Window

Click the **Expand** button to open the time series chart in a floating, resizable window. This gives you a larger view for detailed analysis. The window can be dragged and resized. Click the X button or press <kbd>Escape</kbd> to close it.
