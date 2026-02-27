#!/usr/bin/env node
/**
 * One-time migration: move storage_*.json files into per-aquifer subfolders
 * with the new naming convention: {aquiferSlug}/raster_{dataType}_{code}.json
 *
 * Usage: node scripts/migrate-storage-to-rasters.mjs
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.resolve(__dirname, '..', 'public', 'data');

const slugify = (s) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');

let migrated = 0;

for (const regionEntry of fs.readdirSync(dataDir, { withFileTypes: true })) {
  if (!regionEntry.isDirectory()) continue;
  const regionDir = path.join(dataDir, regionEntry.name);

  for (const file of fs.readdirSync(regionDir)) {
    if (!file.startsWith('storage_') || !file.endsWith('.json')) continue;

    const filePath = path.join(regionDir, file);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    } catch (e) {
      console.warn(`  Skipping malformed file: ${filePath}`);
      continue;
    }

    const aquiferName = data.aquiferName;
    const code = data.code || file.replace('storage_', '').replace('.json', '');

    if (!aquiferName) {
      console.warn(`  Skipping ${file} — no aquiferName field`);
      continue;
    }

    // Add dataType field if missing
    if (!data.dataType) {
      data.dataType = 'wte';
    }

    const aquiferSlug = slugify(aquiferName);
    const newDir = path.join(regionDir, aquiferSlug);
    const newFile = `raster_wte_${code}.json`;
    const newPath = path.join(newDir, newFile);

    fs.mkdirSync(newDir, { recursive: true });
    fs.writeFileSync(newPath, JSON.stringify(data), 'utf-8');
    fs.unlinkSync(filePath);

    console.log(`  ${regionEntry.name}/${file} → ${regionEntry.name}/${aquiferSlug}/${newFile}`);
    migrated++;
  }
}

console.log(`\nMigration complete: ${migrated} file(s) moved.`);
