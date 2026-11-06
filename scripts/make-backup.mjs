#!/usr/bin/env node
/**
 * Package region folders from public/data as a My Data backup zip, the same
 * format the app's Back up button writes, so they can be loaded with Restore.
 *
 * This is how regions that lived on disk while the app had a dev-server file
 * API get into My Data now that it lives in the browser.
 *
 * Usage:
 *   node scripts/make-backup.mjs out.zip                  every folder that is not Sample Data
 *   node scripts/make-backup.mjs out.zip jamaica niger    just these
 *   node scripts/make-backup.mjs out.zip --from ../aquiferx_private/data jamaica
 *                                                         from another folder (development regions live there)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { SAMPLE_REGIONS } from './sample-regions.mjs';

const args = process.argv.slice(2);
const fromAt = args.indexOf('--from');
const from = fromAt >= 0 ? args.splice(fromAt, 2)[1] : null;
const [out, ...named] = args;
if (!out || (fromAt >= 0 && !from)) {
  console.error('Usage: node scripts/make-backup.mjs <out.zip> [--from <dir>] [region ...]');
  process.exit(1);
}

const dataDir = from
  ? path.resolve(from)
  : path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'public', 'data');
const regions = named.length
  ? named
  : fs.readdirSync(dataDir, { withFileTypes: true })
      .filter(e => e.isDirectory() && !SAMPLE_REGIONS.includes(e.name) && fs.existsSync(path.join(dataDir, e.name, 'region.json')))
      .map(e => e.name);

const zip = new JSZip();
const addDir = (dir, prefix) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) addDir(full, `${prefix}/${entry.name}`);
    else zip.file(`${prefix}/${entry.name}`, fs.readFileSync(full, 'utf-8'));
  }
};
for (const id of regions) addDir(path.join(dataDir, id), id);

fs.writeFileSync(out, await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' }));
console.log(`Wrote ${out}: ${regions.join(', ')}`);
