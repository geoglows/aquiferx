# Spatial Interpolation

We have a Spatial Analysis tool that interpolates the water level time series in time at selected periods and then for each period, it interpolates spatially to the aquifer domain using kriging. I would like to add some additional interpolation options and restructure the process.

## Multi Step Wizard

Right now the command brings up a single window with a lot of options, most of which relate to the temporal interpolation. I want to break this into a 3-step wizard:

The wizard should have a progress indicator showing the current step (e.g., "Step 1 of 3"). Each step should have Back and Next buttons (Back disabled on Step 1, Next replaced by "Run Analysis" on Step 3). A Cancel button should be available on every step to close the wizard without running.

**Step 1 - Temporal Interpolation**

This would be the same options we currently have, except for the control to enter the title or code (at the bottom). That will be moved to Step 3.

**Step 2 - Spatial Interpolation**

This is a new set of options. It will include two primary interpolation methods:

Kriging - the current method

Inverse Distance Weighted (IDW) - a new method described in more detail below.

There will also be a set of general interpolation options (see below)

**Step 3 - Title**

This will be the title from the bottom of the current page.

## Kriging Options

### Current Implementation

The current kriging implementation uses **ordinary kriging** with a **Gaussian** variogram model. The variogram parameters are estimated heuristically (not fit to an empirical variogram):
- **Sill** = variance of the well values (data variance)
- **Range** = 1/3 of the spatial diagonal (haversine distance across the data extent)
- **Nugget** = 5% of the sill

The variogram is estimated once per analysis run using each well's mean interpolated value across all timesteps, then reused for all timesteps. Distances are computed using the Haversine formula. Wells within 10m of each other are deduplicated (averaged) before kriging to prevent singular matrices.

### Kriging Options to Present

We will keep the heuristic approach for estimating variogram parameters (sill from data variance, range and nugget as described below) but expose the following options:

**Variogram Model:**
- Spherical
- Exponential
- Gaussian (default — current behavior)

**Nugget Effect:**
- On/Off toggle (default: On, set to 5% of sill as currently implemented)

**Range:**
- Auto — 1/3 of spatial diagonal (default — current behavior)
- Custom value — user enters a distance in the region's length unit
- Percentage of domain — user enters a percentage (e.g., 33% = current default)

We will keep **ordinary kriging** only. Universal and simple kriging add complexity with minimal benefit for typical groundwater use cases.

### Error Handling

If kriging produces a singular matrix (which can happen with certain variogram parameter combinations or data configurations), the system should display a modal dialog informing the user of the error and suggesting they adjust the variogram parameters (e.g., try a different model, increase the nugget, or adjust the range).

## IDW Options and Calculations

This is a new method that we need to implement. It will use the inverse distance weighting formula.

The simplest form of inverse distance weighted interpolation is sometimes called **Shepard's method**. The interpolated value is defined as

$F(x,y) = \sum_{i=1}^{n} w_i f_i$,

where

$n$ = the number of scatter points<br>
$f_i$ = the prescribed values at the scatter points, and <br>
$w_i$ = the weights assigned to each scatter point.

### Calculation of Weights

The classical weight function is

$w_i = \dfrac{h_i^{-p}}{\sum_{j=1}^{n} h_j^{-p}}$,

where $p$ is a positive real number called the weighting exponent (commonly $p = 2$).

The distance from the interpolation point $(x,y)$ to scatter point $(x_i,y_i)$ is

$h_i = \sqrt{(x - x_i)^2 + (y - y_i)^2}$.

The weights are normalized so that $\sum_{i=1}^{n} w_i = 1$.

Although the previous equation is the classical form, we will calculate the weights as:

$w_i =
\dfrac{
\left( \dfrac{R - h_i}{R h_i} \right)^2
}{
\sum_{j=1}^{n}
\left( \dfrac{R - h_j}{R h_j} \right)^2
}$,

where:

$h_i$ = the distance from the interpolation point to scatter point $i$, and <br>
$R$ = the distance to the most distant scatter point in the active set, and <br>
$n$ = the total number of scatter points in the active set.

**Note on R:** When using "all points" mode, $R$ is the distance from the interpolation point to the farthest scatter point in the entire dataset. When using "nearest N points" mode, $R$ is the distance from the interpolation point to the farthest of the N nearest neighbors (i.e., the Nth nearest point).

### Coincident Point Handling

If an interpolation point coincides with a scatter point (i.e., $h_i = 0$), the interpolated value is set directly to $f_i$ (the value at that scatter point) without computing weights. This avoids division by zero.

### Gradient Plane Nodal Functions

A limitation of Shepard's method is that the interpolating surface is a simple weighted average of the data values of the scatter points and is constrained to lie between the extreme values in the dataset. In other words, the surface does not infer local maxima or minima implicit in the dataset. This problem can be overcome by generalizing the basic form of the equation for Shepard's method in the following manner:

$F(x,y) = \sum_{i=1}^{n} w_i Q_i(x,y)$,

where $Q_i$ are nodal functions or individual functions defined at each scatter point (Franke 1982; Watson & Philip 1985). The value of an interpolation point is calculated as the weighted average of the values of the nodal functions at that point.

The standard form of Shepard's method can be thought of as a special case where horizontal planes (constants) are used for the nodal functions. The nodal functions can be sloping planes that pass through the scatter point. The equation for the plane is as follows:

$Q_i(x,y) = f_x (x - x_i) + f_y (y - y_i) + f_i$,

where $f_x$ and $f_y$ are partial derivatives at the scatter point that have been previously estimated based on the geometry of the surrounding scatter points. Gradients are finding the coefficients of a plane that passes through the point, and approximates neighboring points using a weighted least squares regression (could use the same weights as above).

The planes represented by the above equation are sometimes called "gradient planes". By averaging planes rather than constant values at each scatter point, the resulting surface infers extremities and is asymptotic to the gradient plane at the scatter point rather than forming a flat plateau at the scatter point.

### Quadratic Nodal Functions

The nodal functions used in inverse distance weighted interpolation can be higher degree polynomial functions constrained to pass through the scatter point and approximate the nearby points in a least squares manner. Quadratic polynomials have been found to work well in many cases (Franke & Nielson 1980; Franke 1982). The resulting surface reproduces local variations implicit in the dataset, is smooth, and approximates the quadratic nodal functions near the scatter points. The equation used for the quadratic nodal function centered at point $k$ is as follows:

$Q_k(x,y) = a_{k1} + a_{k2}(x - x_k) + a_{k3}(y - y_k) + a_{k4}(x - x_k)^2 + a_{k5}(x - x_k)(y - y_k) + a_{k6}(y - y_k)^2$.

To define the function, the six coefficients $a_{k1}, \dots, a_{k6}$ must be found. Since the function is centered at point $k$ and passes through point $k$, we know beforehand that $a_{k1} = f_k$, where $f_k$ is the function value at point $k$. The equation simplifies to:

$Q_k(x,y) = f_k + a_{k2}(x - x_k) + a_{k3}(y - y_k) + a_{k4}(x - x_k)^2 + a_{k5}(x - x_k)(y - y_k) + a_{k6}(y - y_k)^2$.

Now there are only five unknown coefficients. The coefficients are found by fitting the quadratic to the nearest $N_Q$ scatter points using a weighted least squares approach. In order for the matrix equation used to solve for the coefficients to be stable, there should be at least five scatter points in the set.

### Number of Neighboring Points

The number of neighboring points used to calculate the weights and the nodal functions can have a significant effect on the results. There should be 2 options: use all points or use the nearest N points. If the user selects the nearest N points option, then we should present an option to set the number of points. The default should be to use the nearest 24 points.

**Minimum N validation:** When quadratic nodal functions are selected, N must be at least 6 (5 unknown coefficients + margin for stability). The UI should enforce this minimum and show a validation error if the user enters a value below 6.

Finding the nearest points can be done using a spatial index, such as a k-d tree. We can use the `kd-tree-javascript` npm package to build the k-d tree once for all scatter points, and then query it for each interpolation point to find the nearest neighbors. This is also useful for kriging when we add nearest-N support there in the future.

### Error Handling

If the weighted least squares fit for gradient plane or quadratic nodal functions fails at a particular scatter point (e.g., too few non-coincident neighbors), fall back to the classic constant nodal function ($Q_i = f_i$) for that point. If the overall interpolation fails, display a modal dialog informing the user of the error.

### Summary

When the IDW option is selected, we should present the following options:

Exponent - default to 2.0

Nodal functions:

- Classic form (no nodal functions)
- Gradient plane nodal functions (default)
- Quadratic nodal functions

Default nodal function option = Gradient Plane

Neighboring points:
- Use all points
- Use nearest N points (default, N=24, minimum 6 when quadratic is selected)

## General Interpolation Options

We need to present some general options that apply to both kriging and IDW. These include:

**Truncate low values** — Off by default. When enabled, the default minimum value is 0. Any interpolated values below the minimum will be clamped to the minimum value. This is useful for data types where negative values are physically meaningless.

**Truncate high values** — Off by default. When enabled, the default maximum value is the maximum observed value across all wells and all time steps. Any interpolated values above the maximum will be clamped to the maximum value.

**Log interpolation** — Off by default. This is primarily useful for water quality data where values can span orders of magnitude. When enabled, the natural log of the data is taken before interpolation, and the exponential is applied to the results after interpolation.

**Log interpolation data validation:** Before enabling log interpolation, scan all data values across all wells and time steps. If any values are zero or negative, disable the log interpolation toggle and show a tooltip/message explaining that log interpolation requires all positive values. This prevents runtime errors from attempting `ln(0)` or `ln(negative)`.

## Default Title

For the last step, we should present an option to set the title of the raster that will be created. The title is used to create the code, which is used to reference the raster in other parts of the application. We generate the code from the title by converting to lowercase and replacing spaces with underscores.

**Allowed characters in title:** letters, numbers, spaces, underscores, and hyphens.

As they enter the title, we show the generated code in real time in a read-only field below the title input. This code includes the data type prefix. For example, if the title is "IDW Gradient Plane" and the data type is water table elevation (wte), then the code would be "wte_idw_gradient_plane". The raster would be saved to a file called "raster_wte_idw_gradient_plane.json" in the associated aquifer directory.

We check for duplicate codes against existing rasters and show an error message preventing the user from proceeding until they enter a unique title.

**Note:** This follows the same naming scheme as the current implementation (`raster_{dataType}_{code}.json`). No migration of existing raster files is needed — existing rasters can be deleted and regenerated with the new system.

## Saving Options

When we generate the raster and save it to the JSON file, we extend the existing `RasterAnalysisResult` structure with an `options` object and a `generatedAt` timestamp. The structure will be:

```json
{
  "...existing RasterAnalysisResult fields...",
  "options": {
    "temporal": {
      "method": "pchip|movingAverage",
      "maWindow": 12,
      "startDate": "2020-01-01",
      "endDate": "2025-01-01",
      "interval": "1year",
      "minObservations": 5,
      "minTimeSpan": 5
    },
    "spatial": {
      "method": "kriging|idw",
      "resolution": 50,
      "kriging": {
        "variogramModel": "gaussian|spherical|exponential",
        "nugget": true,
        "rangeMode": "auto|custom|percentage",
        "rangeValue": null
      },
      "idw": {
        "exponent": 2.0,
        "nodalFunction": "classic|gradient|quadratic",
        "neighborMode": "all|nearest",
        "neighborCount": 24
      }
    },
    "general": {
      "truncateLow": false,
      "truncateLowValue": 0,
      "truncateHigh": false,
      "truncateHighValue": null,
      "logInterpolation": false
    }
  },
  "generatedAt": "2026-02-28T12:00:00.000Z"
}
```

Only the relevant spatial method options (kriging or idw) need to be populated based on which method was used. This allows the user to see exactly what settings were used to generate any raster via the "Get Info" option.

## Raster Management

When we list the rasters in the application in the UI panel on the left, we should have a kebab with the following options:

- **Edit** — Edit the title/code. Same validation as during creation (allowed characters, uniqueness check). This will rename the file on disk (`raster_wte_old_code.json` -> `raster_wte_new_code.json`), update the code inside the JSON file, and update references in the application. This requires a new API endpoint in `vite.config.ts` for renaming raster files (the current middleware only has save-data, delete-file, and delete-folder).

- **Delete** — Delete the raster file and remove it from the listing. Show a confirmation dialog before deleting to prevent accidental deletions. (Already partially implemented in the current sidebar.)

- **Get Info** — Show a modal dialog displaying the options that were used to generate the raster (read from the `options` object in the JSON file), along with the `generatedAt` timestamp. For any rasters that lack saved options (pre-existing rasters), show "N/A" for the options fields.
