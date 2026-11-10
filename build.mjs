#!/usr/bin/env node
/**
 * Optional: build (or rebuild) the patched copy now and print its status.
 * launch.mjs does this automatically on start, so you rarely need it.
 *
 *   node build.mjs           build if needed
 *   node build.mjs --force   rebuild
 */
import {ensurePatched} from './launch.mjs';
import {TESTED_VERSIONS} from './lib/patch.mjs';

const result = await ensurePatched({force: process.argv.includes('--force')});
console.log(`chrome-devtools-mcp ${result.version} (${result.source})`);
if (result.patched) {
  console.log(`patched build: ${result.bin}`);
  if (!TESTED_VERSIONS.includes(result.version)) {
    console.log(`note: tested with ${TESTED_VERSIONS.join(', ')} only`);
  }
} else {
  console.error(`patch FAILED: ${result.error?.message}`);
  process.exit(1);
}
