#!/usr/bin/env node
/**
 * MCP entry point: use this file instead of chrome-devtools-mcp's own bin.
 *
 * On every start it checks the globally installed chrome-devtools-mcp version.
 * If no patched copy exists for that version (e.g. right after
 * `npm install -g chrome-devtools-mcp@latest`), it builds one into ./dist and
 * then runs it. All command-line flags are passed through unchanged.
 *
 * If the patch no longer applies to a new upstream version, it logs a warning
 * and runs the unpatched upstream server, so the MCP keeps working.
 */
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

import {buildPatched, findGlobalPackage, packageVersion, patchHash, ROOT, TESTED_VERSIONS} from './lib/patch.mjs';

const log = msg => process.stderr.write(`[profile-pin] ${msg}\n`);
const DIST = path.join(ROOT, 'dist');
const KEEP_OLD_BUILDS_DAYS = 14;

function binOf(dir) {
  return path.join(dir, 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function cleanupOldBuilds(current) {
  let entries = [];
  try {
    entries = fs.readdirSync(DIST, {withFileTypes: true});
  } catch {
    return;
  }
  const now = Date.now();
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name === current) {
      continue;
    }
    const full = path.join(DIST, entry.name);
    const ageDays = (now - fs.statSync(full).mtimeMs) / 86_400_000;
    // Old builds may still be used by long-running sessions, so only remove
    // them after a while. Leftover temp dirs go after a day.
    const limit = entry.name.includes('.tmp-') ? 1 : KEEP_OLD_BUILDS_DAYS;
    if (ageDays > limit) {
      fs.rmSync(full, {recursive: true, force: true});
    }
  }
}

/**
 * Returns {bin, patched, version, source}. Builds the patched copy if needed.
 */
export async function ensurePatched({force = false} = {}) {
  const source = findGlobalPackage();
  const version = packageVersion(source);
  const stamp = `${version}-${patchHash()}`;
  const outDir = path.join(DIST, stamp);
  const ready = path.join(outDir, '.ready');
  if (force) {
    fs.rmSync(outDir, {recursive: true, force: true});
  }
  if (!fs.existsSync(ready)) {
    const tmp = `${outDir}.tmp-${process.pid}`;
    try {
      fs.mkdirSync(DIST, {recursive: true});
      buildPatched(source, tmp);
      fs.writeFileSync(path.join(tmp, '.ready'), `${new Date().toISOString()}\n`);
      try {
        fs.renameSync(tmp, outDir);
        log(`built patched chrome-devtools-mcp ${version} in ${outDir}`);
      } catch {
        // Another session built it at the same time.
        fs.rmSync(tmp, {recursive: true, force: true});
        for (let i = 0; i < 50 && !fs.existsSync(ready); i++) {
          await sleep(200);
        }
        if (!fs.existsSync(ready)) {
          throw new Error(`could not create ${outDir}`);
        }
      }
      cleanupOldBuilds(stamp);
    } catch (error) {
      fs.rmSync(tmp, {recursive: true, force: true});
      return {bin: binOf(source), patched: false, version, source, error};
    }
  }
  return {bin: binOf(outDir), patched: true, version, source};
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));

if (isMain) {
  let result;
  try {
    result = await ensurePatched();
  } catch (error) {
    log(error.message);
    process.exit(1);
  }
  if (!result.patched) {
    log(`could not patch chrome-devtools-mcp ${result.version}: ${result.error?.message}`);
    log('running the unpatched server (no profile pinning). Check for an update of chrome-devtools-mcp-profile-pin.');
  } else if (!TESTED_VERSIONS.includes(result.version)) {
    log(`note: the patch was tested with chrome-devtools-mcp ${TESTED_VERSIONS.join(', ')}; running it on ${result.version}.`);
  }
  await import(pathToFileURL(result.bin).href);
}
