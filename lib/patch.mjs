/**
 * Builds a patched copy of an installed chrome-devtools-mcp package.
 *
 * The patch is applied to the built JavaScript with exact-match anchors. If any
 * anchor is missing (upstream changed the code), the build fails loudly instead
 * of producing a half-patched server.
 */
import {execFileSync} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const PACKAGE = 'chrome-devtools-mcp';
export const TESTED_VERSIONS = ['1.12.0'];

const EXTRA_FILES = [
  ['src/profilePin.js', 'build/src/profilePin.js'],
  ['src/tools/profile.js', 'build/src/tools/profile.js'],
];

const EDITS = {
  'BrowserManager.js': [
    [
      "import { isAllowedUrl } from './utils/url.js';",
      "import { isAllowedUrl } from './utils/url.js';\nimport { pinProfile } from './profilePin.js';",
    ],
    [
      "        logger?.('Connecting Puppeteer to ', JSON.stringify(redactConnectOptionsForLogging(connectOptions)));",
      '        const pinnedProfile = await pinProfile(connectOptions, { userDataDir, channel });\n' +
        "        logger?.('Connecting Puppeteer to ', JSON.stringify(redactConnectOptionsForLogging(connectOptions)));",
    ],
    [
      "            this.#browserMode = 'connected';\n            this.#browser = connected;",
      "            this.#browserMode = 'connected';\n            this.#browser = connected;\n            pinnedProfile?.attach(connected);",
    ],
  ],
  'McpContext.js': [
    [
      '            page = await this.browser.newPage({ background });',
      '            page = this.browser.__pinnedProfile\n' +
        '                ? await this.browser.__pinnedProfile.newPage({ background })\n' +
        '                : await this.browser.newPage({ background });',
    ],
  ],
  'McpResponse.js': [
    [
      "                const parts = [`## Pages`];",
      "                const pinnedLabel = pinnedProfileLabel();\n" +
        "                const parts = [pinnedLabel ? `## Pages (Chrome profile: ${pinnedLabel})` : `## Pages`];",
    ],
  ],
  'index.js': [
    [
      '    async #init() {\n',
      '    async #init() {\n        globalThis.__cdmcpMcpServer = this.server.server;\n',
    ],
  ],
  'tools/tools.js': [
    [
      "import * as pagesTools from './pages.js';",
      "import * as pagesTools from './pages.js';\nimport * as profileTools from './profile.js';",
    ],
    ['        ...Object.values(pagesTools),', '        ...Object.values(pagesTools),\n        ...Object.values(profileTools),'],
  ],
};

// McpResponse needs the import too; added separately so the anchor list above
// stays readable.
const IMPORTS = {
  'McpResponse.js': "import { pinnedProfileLabel } from './profilePin.js';\n",
};

/** Hash of everything that influences the patched output. */
export function patchHash() {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(fileURLToPath(import.meta.url)));
  for (const [from] of EXTRA_FILES) {
    hash.update(fs.readFileSync(path.join(ROOT, from)));
  }
  return hash.digest('hex').slice(0, 12);
}

export function findGlobalPackage() {
  if (process.env.CHROME_DEVTOOLS_MCP_SOURCE) {
    return process.env.CHROME_DEVTOOLS_MCP_SOURCE;
  }
  const candidates = [];
  if (process.platform === 'win32' && process.env.APPDATA) {
    candidates.push(path.join(process.env.APPDATA, 'npm', 'node_modules', PACKAGE));
  }
  candidates.push(path.join(path.dirname(process.execPath), '..', 'lib', 'node_modules', PACKAGE));
  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'package.json'))) {
      return candidate;
    }
  }
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  const root = execFileSync(npm, ['root', '-g'], {encoding: 'utf8', shell: process.platform === 'win32'}).trim();
  const fromNpm = path.join(root, PACKAGE);
  if (!fs.existsSync(path.join(fromNpm, 'package.json'))) {
    throw new Error(`${PACKAGE} is not installed globally. Run: npm install -g ${PACKAGE}@latest`);
  }
  return fromNpm;
}

export function packageVersion(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
}

function addImport(text, importLine) {
  const marker = text.match(/^import .*;$/m);
  if (!marker) {
    throw new Error('no import statement found');
  }
  return text.replace(marker[0], `${marker[0]}\n${importLine.trimEnd()}`);
}

/** Copies `source` to `outDir` and applies the patch. Throws on any mismatch. */
export function buildPatched(source, outDir) {
  fs.rmSync(outDir, {recursive: true, force: true});
  fs.cpSync(source, outDir, {recursive: true});
  for (const [from, to] of EXTRA_FILES) {
    fs.copyFileSync(path.join(ROOT, from), path.join(outDir, to));
  }
  for (const [rel, edits] of Object.entries(EDITS)) {
    const file = path.join(outDir, 'build', 'src', rel);
    let text = fs.readFileSync(file, 'utf8');
    for (const [anchor, replacement] of edits) {
      const count = text.split(anchor).length - 1;
      if (count !== 1) {
        throw new Error(`${rel}: expected the anchor exactly once but found it ${count} times:\n${anchor}`);
      }
      text = text.replace(anchor, () => replacement);
    }
    if (IMPORTS[rel]) {
      text = addImport(text, IMPORTS[rel]);
    }
    fs.writeFileSync(file, text);
  }
  return path.join(outDir, 'build', 'src', 'bin', 'chrome-devtools-mcp.js');
}
