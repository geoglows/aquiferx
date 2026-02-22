/**
 * Migration script: Convert from centralized regions.json + water_levels.csv
 * to per-folder region.json + data_wte.csv with 'value' column.
 *
 * Run with: npx tsx scripts/migrate_data_files.ts
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const dataDir = path.resolve(__dirname, '../public/data');
const regionsJsonPath = path.join(dataDir, 'regions.json');

function splitCSVLine(line: string, delimiter: string): string[] {
  const fields: string[] = [];
  let current = '';
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (i + 1 < line.length && line[i + 1] === '"') {
          current += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        current += ch;
      }
    } else {
      if (ch === '"') {
        inQuotes = true;
      } else if (ch === delimiter) {
        fields.push(current.trim());
        current = '';
      } else {
        current += ch;
      }
    }
  }
  fields.push(current.trim());
  return fields;
}

function main() {
  // 1. Read centralized regions.json
  if (!fs.existsSync(regionsJsonPath)) {
    console.log('No regions.json found — nothing to migrate.');
    return;
  }

  const regionsData: { id: string; path: string; name: string; lengthUnit?: string }[] =
    JSON.parse(fs.readFileSync(regionsJsonPath, 'utf-8'));

  console.log(`Found ${regionsData.length} regions to migrate.\n`);

  for (const region of regionsData) {
    const folderPath = path.join(dataDir, region.id);
    if (!fs.existsSync(folderPath)) {
      console.log(`  SKIP ${region.id}: folder does not exist`);
      continue;
    }

    console.log(`Migrating ${region.id} (${region.name})...`);

    // 2a. Create region.json
    const regionMeta = {
      id: region.id,
      name: region.name,
      lengthUnit: region.lengthUnit || 'ft',
      singleUnit: false,
      dataTypes: [
        { code: 'wte', name: 'Water Table Elevation', unit: region.lengthUnit || 'ft' }
      ]
    };
    const regionJsonPath = path.join(folderPath, 'region.json');
    fs.writeFileSync(regionJsonPath, JSON.stringify(regionMeta, null, 2), 'utf-8');
    console.log(`  Created region.json`);

    // 2b. Rename water_levels.csv → data_wte.csv, renaming 'wte' header → 'value'
    const waterLevelsPath = path.join(folderPath, 'water_levels.csv');
    const dataWtePath = path.join(folderPath, 'data_wte.csv');

    if (fs.existsSync(waterLevelsPath)) {
      const text = fs.readFileSync(waterLevelsPath, 'utf-8');
      const lines = text.split('\n');

      if (lines.length > 0) {
        const delimiter = lines[0].includes('\t') ? '\t' : ',';
        const headers = splitCSVLine(lines[0], delimiter);

        // Rename 'wte' → 'value' in headers
        const newHeaders = headers.map(h => h === 'wte' ? 'value' : h);

        // Ensure aquifer_id column exists
        if (!newHeaders.includes('aquifer_id')) {
          newHeaders.push('aquifer_id');
        }

        // Rebuild CSV with new headers
        const newLines = [newHeaders.join(delimiter)];
        for (let i = 1; i < lines.length; i++) {
          if (!lines[i].trim()) continue;
          const values = splitCSVLine(lines[i], delimiter);
          // If we added aquifer_id column and this row is shorter, pad it
          while (values.length < newHeaders.length) {
            values.push('');
          }
          newLines.push(values.join(delimiter));
        }

        fs.writeFileSync(dataWtePath, newLines.join('\n'), 'utf-8');
        console.log(`  Converted water_levels.csv → data_wte.csv (renamed wte → value)`);

        // Remove old water_levels.csv
        fs.unlinkSync(waterLevelsPath);
        console.log(`  Removed water_levels.csv`);
      }
    } else if (fs.existsSync(dataWtePath)) {
      console.log(`  data_wte.csv already exists, skipping conversion`);
    } else {
      console.log(`  No water_levels.csv found, skipping`);
    }

    console.log('');
  }

  // 3. Delete centralized regions.json
  fs.unlinkSync(regionsJsonPath);
  console.log('Deleted centralized regions.json');
  console.log('\nMigration complete!');
}

main();
