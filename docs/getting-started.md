# Getting Started

This guide covers everything you need to install AquiferX and begin working with groundwater data.

## System Requirements

- **Node.js** 18 or later
- **Modern web browser**: Chrome, Firefox, Edge, or Safari (latest two major versions)
- **Operating system**: Windows, macOS, or Linux
- **Git** — required to clone the repository

### Installing Git

If you don't already have Git installed, follow the instructions for your operating system:

=== "Windows"

1. Download the installer from [git-scm.com](https://git-scm.com/download/win).
2. Run the installer and accept the default settings.
3. After installation, open **Git Bash** or **Command Prompt** and verify:

        git --version

=== "macOS"

Open **Terminal** and run:

    git --version

If Git is not installed, macOS will prompt you to install the Xcode Command Line Tools. Click **Install** and follow the prompts. Alternatively, install via [Homebrew](https://brew.sh/):

    brew install git

After installing, verify Git is available by running:

    git --version

## Installation

1. **Clone the repository**:

        git clone https://github.com/njones61/aquiferx.git
        cd aquiferx

2. **Install dependencies**:

        npm install

3. **Start the development server**:

        npm run dev

   The app starts on [http://localhost:3000](http://localhost:3000).

The steps above are for the fist installation only. After the initial installation, you simply need to navigate to the `aquiferx` folder and run `npm run dev` to start the app:

        cd aquiferx
        npm run dev

## First Launch

When you open the app for the first time, you will see:

- A **sidebar** on the left listing available regions (initially empty or pre-loaded with sample data).
- An **interactive map** in the center.
- A **toolbar** along the top with buttons for managing data, running analyses, and switching data types.

<!-- screenshot: Initial app view with empty state or sample data loaded -->

If sample data is included with the repository, you will see one or more regions listed in the sidebar. Click a region name to expand it and view its aquifers and wells.

## Quick Start Walkthrough

### Step 1: Load a Region

Click the **Manage Data** button in the toolbar to open the Import Data Hub. From here you can:

- **Create a new region** by clicking "New Region" and following the wizard.
- **Import a packaged region** from a ZIP file containing pre-formatted data.

See [Managing Data](managing-data.md) for detailed import instructions.

### Step 2: View Wells on the Map

After loading a region, expand the region in the sidebar and click on an aquifer to see its wells on the map. Wells appear as colored circles — the color reflects the number of available measurements.

### Step 3: Explore a Time Series

Click any well on the map or in the sidebar to display its measurement time series in the chart panel below the map. The chart shows:

- **Measurement dots** — the actual recorded data points.
- **PCHIP interpolation curve** — a smooth line drawn through the measurements.

### Step 4: Try Multi-Well Selection

Hold <kbd>Shift</kbd> and click additional wells to add them to your selection. Each well gets its own color-coded line in the chart. You can also hold <kbd>Shift</kbd> and drag a box on the map to select all wells within a region.

### Step 5: Run an Analysis

Once you have data loaded, explore the analysis tools:

- **Trend Analysis** — Click the trend button to see rising/declining water levels across all wells.
- **Spatial Analysis** — Interpolate measurements across the aquifer to create animated raster surfaces.
- **Impute Data** — Use machine learning to fill gaps in sparse measurement records.

## What's Next?

- [Overview](overview.md) — Understand the full interface and data architecture.
- [Preparing Data](data-preparation.md) — Learn how to format your data files.
- [Managing Data](managing-data.md) — Step-by-step import and export instructions.
