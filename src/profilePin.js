/**
 * profilePin.js — attach chrome-devtools-mcp to ONE Chrome profile.
 *
 * Copied into chrome-devtools-mcp/build/src/ by lib/patch.mjs.
 *
 * Profile selection (first match wins):
 *   1. select_profile tool (this session)
 *   2. CHROME_DEVTOOLS_MCP_PROFILE=<folder or display name>   ("off" disables pinning)
 *   3. Only one profile has open windows  -> no pinning needed (upstream behaviour)
 *   4. A remembered choice (~/.chrome-devtools-mcp-profile-pin/state.json)
 *   5. Ask the user via MCP elicitation (if the client supports it)
 *   6. Otherwise fail with a message telling the agent to ask the user and call
 *      select_profile.
 *
 * Mechanism:
 *   - ONE WebSocket to Chrome (one "Allow remote debugging?" dialog), handed to
 *     Puppeteer afterwards via connect({transport}).
 *   - `chrome --profile-directory=<dir> data:text/html,<nonce>` makes the running
 *     Chrome open a tab in that profile (opening its window if needed). The
 *     tab's browserContextId identifies the profile. No script runs in user pages.
 *   - Puppeteer's targetFilter rejects targets of every other profile.
 *   - new_page uses Target.createTarget({browserContextId}) and falls back to the
 *     same command-line trick (Chrome only accepts the id of the last-focused
 *     profile).
 */
import {spawn} from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const PROFILE_ENV = 'CHROME_DEVTOOLS_MCP_PROFILE';
const CHROME_PATH_ENV = 'CHROME_DEVTOOLS_MCP_CHROME_PATH';
const STATE_DIR_ENV = 'CHROME_DEVTOOLS_MCP_PROFILE_STATE_DIR';
const MARKER_PREFIX = 'cdmcp-profile-';
const LOG = msg => process.stderr.write(`[profile-pin] ${msg}\n`);

/** Per-process state (one MCP server per process). */
const session = {
  override: undefined, // profile dir chosen in this session
  pin: undefined, // PinnedProfile | null
  browser: undefined,
  lastOpts: {userDataDir: undefined, channel: undefined},
};

// ---------------------------------------------------------------------------
// Chrome locations and profiles
// ---------------------------------------------------------------------------

export function defaultUserDataDir(channel = 'stable') {
  if (process.platform === 'win32') {
    const dirs = {stable: 'Chrome', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome SxS'};
    return path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), 'AppData', 'Local'), 'Google', dirs[channel] ?? 'Chrome', 'User Data');
  }
  if (process.platform === 'darwin') {
    const dirs = {stable: 'Chrome', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome Canary'};
    return path.join(os.homedir(), 'Library', 'Application Support', 'Google', dirs[channel] ?? 'Chrome');
  }
  const dirs = {stable: 'google-chrome', beta: 'google-chrome-beta', dev: 'google-chrome-unstable', canary: 'google-chrome-canary'};
  return path.join(os.homedir(), '.config', dirs[channel] ?? 'google-chrome');
}

function findChrome(channel = 'stable') {
  if (process.env[CHROME_PATH_ENV]) {
    return process.env[CHROME_PATH_ENV];
  }
  const candidates = [];
  if (process.platform === 'win32') {
    const app = {stable: 'Chrome', beta: 'Chrome Beta', dev: 'Chrome Dev', canary: 'Chrome SxS'}[channel] ?? 'Chrome';
    for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
      if (base) {
        candidates.push(path.join(base, 'Google', app, 'Application', 'chrome.exe'));
      }
    }
  } else if (process.platform === 'darwin') {
    const app = {stable: 'Google Chrome', beta: 'Google Chrome Beta', dev: 'Google Chrome Dev', canary: 'Google Chrome Canary'}[channel] ?? 'Google Chrome';
    candidates.push(`/Applications/${app}.app/Contents/MacOS/${app}`);
  } else {
    const bin = {stable: 'google-chrome-stable', beta: 'google-chrome-beta', dev: 'google-chrome-unstable', canary: 'google-chrome-canary'}[channel] ?? 'google-chrome-stable';
    candidates.push(`/usr/bin/${bin}`, '/usr/bin/google-chrome', '/opt/google/chrome/chrome');
  }
  const found = candidates.find(c => fs.existsSync(c));
  if (!found) {
    throw new Error(`[profile-pin] Chrome executable not found. Set ${CHROME_PATH_ENV}. Tried: ${candidates.join(', ')}`);
  }
  return found;
}

/** [{dir, name}] from Local State. */
export function listProfiles(userDataDir) {
  try {
    const localState = JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'));
    const cache = localState?.profile?.info_cache ?? {};
    return Object.entries(cache)
      .map(([dir, info]) => ({dir, name: String(info?.name ?? dir)}))
      .sort((a, b) => a.dir.localeCompare(b.dir, undefined, {numeric: true}));
  } catch {
    return [];
  }
}

function lastUsedProfile(userDataDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(userDataDir, 'Local State'), 'utf8'))?.profile?.last_used;
  } catch {
    return undefined;
  }
}

/** Accepts a profile folder name ("Profile 1") or a display name ("Work"). */
export function resolveProfileDir(userDataDir, wanted) {
  const value = String(wanted).trim();
  const profiles = listProfiles(userDataDir);
  if (profiles.some(p => p.dir === value) || fs.existsSync(path.join(userDataDir, value, 'Preferences'))) {
    return value;
  }
  const lower = value.toLowerCase();
  const match = profiles.find(p => p.name.trim().toLowerCase() === lower) ?? profiles.find(p => p.dir.toLowerCase() === lower);
  if (match) {
    return match.dir;
  }
  throw new Error(`[profile-pin] Chrome profile "${value}" not found. Known profiles: ${formatProfiles(profiles) || 'none'}`);
}

function formatProfiles(profiles) {
  return profiles.map(p => (p.name === p.dir ? `"${p.dir}"` : `"${p.name}" (${p.dir})`)).join(', ');
}

function profileName(userDataDir, dir) {
  return listProfiles(userDataDir).find(p => p.dir === dir)?.name ?? dir;
}

function chromeTarget(opts) {
  const channel = opts.channel ?? 'stable';
  const defaultDir = defaultUserDataDir(channel);
  const userDataDir = opts.userDataDir ?? defaultDir;
  return {
    channel,
    userDataDir,
    isDefaultUserDataDir: path.resolve(userDataDir).toLowerCase() === path.resolve(defaultDir).toLowerCase(),
  };
}

// ---------------------------------------------------------------------------
// Remembered choice
// ---------------------------------------------------------------------------

function stateFile() {
  const dir = process.env[STATE_DIR_ENV] ?? path.join(os.homedir(), '.chrome-devtools-mcp-profile-pin');
  return path.join(dir, 'state.json');
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(stateFile(), 'utf8'));
  } catch {
    return {};
  }
}

function writeState(patch) {
  const file = stateFile();
  fs.mkdirSync(path.dirname(file), {recursive: true});
  const next = {...readState(), ...patch};
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
  fs.renameSync(tmp, file);
}

function rememberedKey(target) {
  return target.isDefaultUserDataDir ? `default:${target.channel}` : path.resolve(target.userDataDir);
}

function readRemembered(target) {
  return readState().remembered?.[rememberedKey(target)];
}

function writeRemembered(target, dir) {
  const remembered = {...(readState().remembered ?? {})};
  if (dir) {
    remembered[rememberedKey(target)] = dir;
  } else {
    delete remembered[rememberedKey(target)];
  }
  writeState({remembered});
}

// ---------------------------------------------------------------------------
// CDP plumbing
// ---------------------------------------------------------------------------

function readDevToolsActivePort(userDataDir) {
  const portPath = path.join(userDataDir, 'DevToolsActivePort');
  const [rawPort, rawPath] = fs.readFileSync(portPath, 'utf8').split('\n').map(l => l.trim()).filter(Boolean);
  if (!rawPort || !rawPath) {
    throw new Error(`[profile-pin] Invalid DevToolsActivePort at ${portPath}`);
  }
  return `ws://127.0.0.1:${parseInt(rawPort, 10)}${rawPath}`;
}

function isLocalUrl(url) {
  try {
    const host = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return host === 'localhost' || host.endsWith('.localhost') || host === '::1' || host.startsWith('127.') || host === '0.0.0.0' || host === '::';
  } catch {
    return false;
  }
}

/** Minimal Puppeteer ConnectionTransport over Node's built-in WebSocket. */
class WsTransport {
  static open(url) {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.onopen = () => resolve(new WsTransport(ws));
      ws.onerror = () => reject(new Error('[profile-pin] Could not open the WebSocket to Chrome. Was "Allow remote debugging?" approved, and is remote debugging enabled in chrome://inspect/#remote-debugging?'));
    });
  }
  constructor(ws) {
    this.ws = ws;
    this.onmessage = undefined;
    this.onclose = undefined;
    ws.onmessage = event => {
      const data = typeof event.data === 'string' ? event.data : Buffer.from(event.data).toString('utf8');
      this.onmessage?.(data);
    };
    ws.onclose = () => this.onclose?.();
    ws.onerror = () => {};
  }
  send(message) {
    this.ws.send(message);
  }
  close() {
    this.ws.close();
  }
  toJSON() {
    return '[profile-pin WsTransport]';
  }
}

/** Tiny CDP client used only before the transport is handed to Puppeteer. */
function rawClient(transport) {
  let nextId = 1_000_000_000;
  const pending = new Map();
  const listeners = new Set();
  transport.onmessage = data => {
    const msg = JSON.parse(data);
    if (msg.id !== undefined && pending.has(msg.id)) {
      const {resolve, reject} = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(msg.error.message)) : resolve(msg.result);
    } else if (msg.method) {
      for (const listener of listeners) {
        listener(msg);
      }
    }
  };
  return {
    send(method, params = {}) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, {resolve, reject});
        transport.send(JSON.stringify({id, method, params}));
      });
    },
    on(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    release() {
      transport.onmessage = undefined;
    },
  };
}

/** Number of regular profiles that currently have page targets. */
async function countOpenProfiles(client) {
  const {browserContextIds = []} = await client.send('Target.getBrowserContexts');
  const cdpCreated = new Set(browserContextIds);
  const {targetInfos} = await client.send('Target.getTargets');
  const contexts = new Set(targetInfos.filter(t => t.type === 'page' && t.browserContextId && !cdpCreated.has(t.browserContextId)).map(t => t.browserContextId));
  return contexts.size;
}

function launchProfileTab(launch, marker) {
  const args = [];
  if (!launch.isDefaultUserDataDir) {
    args.push(`--user-data-dir=${launch.userDataDir}`);
  }
  // A running Chrome ignores about: and chrome:// URLs from the command line,
  // but opens data: URLs.
  args.push(`--profile-directory=${launch.profileDir}`, `data:text/html,<title>chrome-devtools-mcp</title><!--${marker}-->`);
  const child = spawn(launch.chromePath, args, {detached: true, stdio: 'ignore', windowsHide: true});
  child.on('error', error => LOG(`failed to launch Chrome: ${error.message}`));
  child.unref();
}

/** Opens a marker tab in the profile and returns its browserContextId. */
async function resolveContextId(client, launch) {
  await client.send('Target.setDiscoverTargets', {discover: true});
  try {
    const marker = MARKER_PREFIX + crypto.randomUUID();
    const created = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`[profile-pin] Timed out waiting for a tab in Chrome profile "${launch.profileDir}".`));
      }, 15_000);
      const off = client.on(msg => {
        if (msg.method !== 'Target.targetCreated' && msg.method !== 'Target.targetInfoChanged') {
          return;
        }
        const info = msg.params.targetInfo;
        if (info.type === 'page' && info.url.includes(marker)) {
          clearTimeout(timer);
          off();
          resolve(info);
        }
      });
    });
    launchProfileTab(launch, marker);
    const tab = await created;
    if (!tab.browserContextId) {
      throw new Error('[profile-pin] Chrome did not report a browserContextId for the profile tab.');
    }
    const {targetInfos} = await client.send('Target.getTargets');
    const pagesInProfile = targetInfos.filter(t => t.type === 'page' && t.browserContextId === tab.browserContextId);
    if (pagesInProfile.length > 1) {
      await client.send('Target.closeTarget', {targetId: tab.targetId}).catch(() => {});
    }
    return tab.browserContextId;
  } finally {
    await client.send('Target.setDiscoverTargets', {discover: false}).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Asking the user
// ---------------------------------------------------------------------------

async function askUser(target) {
  const server = globalThis.__cdmcpMcpServer;
  const caps = server?.getClientCapabilities?.();
  if (!caps?.elicitation) {
    return undefined;
  }
  const profiles = listProfiles(target.userDataDir);
  if (profiles.length === 0) {
    return undefined;
  }
  const last = lastUsedProfile(target.userDataDir);
  try {
    const result = await server.elicitInput({
      mode: 'form',
      message: 'Several Chrome profiles are open. Which profile should chrome-devtools-mcp use?',
      requestedSchema: {
        type: 'object',
        properties: {
          profile: {
            type: 'string',
            title: 'Chrome profile',
            enum: profiles.map(p => p.dir),
            enumNames: profiles.map(p => (p.name === p.dir ? p.dir : `${p.name} (${p.dir})`)),
            ...(profiles.some(p => p.dir === last) ? {default: last} : {}),
          },
          remember: {
            type: 'boolean',
            title: 'Remember this choice for future sessions',
            default: true,
          },
        },
        required: ['profile'],
      },
    });
    if (result?.action !== 'accept' || !result.content?.profile) {
      return {declined: true};
    }
    return {dir: String(result.content.profile), remember: result.content.remember !== false};
  } catch (error) {
    LOG(`elicitation failed: ${error?.message ?? error}`);
    return undefined;
  }
}

function ambiguityError(target, declined) {
  const profiles = formatProfiles(listProfiles(target.userDataDir));
  return new Error(
    `${declined ? 'No Chrome profile was chosen. ' : ''}Several Chrome profiles are open (known profiles: ${profiles}). ` +
      'Ask the user which Chrome profile to use, then call select_profile with that profile ' +
      '(by display name or folder name). The choice can be remembered for future sessions.',
  );
}

// ---------------------------------------------------------------------------
// Pinned profile
// ---------------------------------------------------------------------------

class PinnedProfile {
  constructor(contextId, launch, source) {
    this.contextId = contextId;
    this.launch = launch;
    this.profileDir = launch.profileDir;
    this.profileName = profileName(launch.userDataDir, launch.profileDir);
    this.source = source;
    this.browser = undefined;
    this.preexistingContexts = new Set();
  }

  attach(browser) {
    this.browser = browser;
    for (const ctx of browser.browserContexts()) {
      if (ctx.id) {
        this.preexistingContexts.add(ctx.id);
      }
    }
    browser.__pinnedProfile = this;
    session.browser = browser;
    session.pin = this;
  }

  /** The pinned profile, plus isolated contexts this server creates later. */
  allows(contextId) {
    if (contextId === this.contextId) {
      return true;
    }
    if (!this.browser || this.preexistingContexts.has(contextId)) {
      return false;
    }
    return this.browser.browserContexts().some(ctx => ctx.id === contextId);
  }

  async newPage({background = false} = {}) {
    const browser = this.browser;
    const cdp = await browser.target().createCDPSession();
    try {
      const {targetId} = await cdp.send('Target.createTarget', {url: 'about:blank', browserContextId: this.contextId, background});
      const target = await browser.waitForTarget(t => t._targetId === targetId, {timeout: 10_000});
      return await target.page();
    } catch (error) {
      if (!/browser context/i.test(String(error?.message))) {
        throw error;
      }
    } finally {
      await cdp.detach().catch(() => {});
    }
    const marker = MARKER_PREFIX + crypto.randomUUID();
    const waiting = browser.waitForTarget(t => t.type() === 'page' && t.url().includes(marker), {timeout: 15_000});
    launchProfileTab(this.launch, marker);
    try {
      const target = await waiting;
      return await target.page();
    } catch (error) {
      // The profile was probably closed and reopened (new browserContextId).
      await browser.disconnect().catch(() => {});
      throw new Error(`Could not open a tab in Chrome profile "${this.profileName}" (was its window closed?). Reconnected; retry the call.`, {cause: error});
    }
  }
}

class Unpinned {
  attach(browser) {
    session.browser = browser;
    session.pin = null;
  }
}

function useTransport(connectOptions, transport) {
  connectOptions.transport = transport;
  delete connectOptions.browserWSEndpoint;
  delete connectOptions.browserURL;
  delete connectOptions.channel;
}

function requestedProfile() {
  if (session.override) {
    return {kind: 'fixed', profile: session.override, source: 'selected in this session'};
  }
  const env = process.env[PROFILE_ENV]?.trim();
  if (env && /^(off|none|false|0)$/i.test(env)) {
    return {kind: 'off'};
  }
  if (env && !/^auto$/i.test(env)) {
    return {kind: 'fixed', profile: env, source: PROFILE_ENV};
  }
  return {kind: 'auto'};
}

/**
 * Called by the patched BrowserManager#connect() right before
 * puppeteer.connect(). May mutate connectOptions. Returns an object whose
 * attach(browser) must be called after connecting, or undefined.
 */
export async function pinProfile(connectOptions, {userDataDir, channel} = {}) {
  session.lastOpts = {userDataDir, channel};
  const request = requestedProfile();
  if (request.kind === 'off') {
    return undefined;
  }
  const target = chromeTarget({userDataDir, channel});

  let wsUrl = connectOptions.browserWSEndpoint;
  if (!wsUrl && connectOptions.browserURL) {
    if (!isLocalUrl(connectOptions.browserURL)) {
      if (request.kind === 'fixed') {
        throw new Error('[profile-pin] Profile pinning only works with a local Chrome.');
      }
      return undefined;
    }
    const response = await fetch(new URL('/json/version', connectOptions.browserURL));
    wsUrl = (await response.json()).webSocketDebuggerUrl;
  }
  if (!wsUrl) {
    wsUrl = readDevToolsActivePort(target.userDataDir);
  }
  if (!isLocalUrl(wsUrl)) {
    if (request.kind === 'fixed') {
      throw new Error('[profile-pin] Profile pinning only works with a local Chrome.');
    }
    return undefined;
  }

  const transport = await WsTransport.open(wsUrl);
  const client = rawClient(transport);
  let profileDir;
  let source;
  try {
    if (request.kind === 'fixed') {
      profileDir = resolveProfileDir(target.userDataDir, request.profile);
      source = request.source;
    } else {
      const open = await countOpenProfiles(client);
      if (open <= 1) {
        client.release();
        useTransport(connectOptions, transport);
        return new Unpinned();
      }
      const remembered = readRemembered(target);
      if (remembered && listProfiles(target.userDataDir).some(p => p.dir === remembered)) {
        profileDir = remembered;
        source = 'remembered';
      } else {
        const answer = await askUser(target);
        if (!answer || answer.declined) {
          throw ambiguityError(target, answer?.declined);
        }
        profileDir = resolveProfileDir(target.userDataDir, answer.dir);
        session.override = profileDir;
        if (answer.remember) {
          writeRemembered(target, profileDir);
        }
        source = answer.remember ? 'chosen and remembered' : 'chosen for this session';
      }
    }
    const launch = {...target, profileDir, chromePath: findChrome(target.channel)};
    const contextId = await resolveContextId(client, launch);
    client.release();
    const pinned = new PinnedProfile(contextId, launch, source);
    LOG(`attached to Chrome profile "${pinned.profileName}" (${profileDir}, ${source})`);
    const baseFilter = connectOptions.targetFilter;
    connectOptions.targetFilter = t => {
      const ctx = t._getTargetInfo?.().browserContextId;
      if (ctx && !pinned.allows(ctx)) {
        return false;
      }
      return baseFilter ? baseFilter(t) : true;
    };
    useTransport(connectOptions, transport);
    return pinned;
  } catch (error) {
    transport.close();
    throw error;
  }
}

/** Shown in the list_pages header. */
export function pinnedProfileLabel() {
  const pin = session.pin;
  if (!pin) {
    return undefined;
  }
  return pin.profileName === pin.profileDir ? pin.profileDir : `${pin.profileName} (${pin.profileDir})`;
}

/** Implementation of the select_profile tool. */
export async function selectProfile({profile, remember = true, forget = false} = {}) {
  const target = chromeTarget(session.lastOpts);
  const profiles = listProfiles(target.userDataDir);
  if (forget) {
    writeRemembered(target, undefined);
  }
  if (!profile) {
    const lines = ['Chrome profiles:'];
    for (const p of profiles) {
      const flags = [];
      if (session.pin?.profileDir === p.dir) {
        flags.push('attached now');
      }
      if (readRemembered(target) === p.dir) {
        flags.push('remembered');
      }
      lines.push(`- ${p.name === p.dir ? p.dir : `${p.name} (${p.dir})`}${flags.length ? ` [${flags.join(', ')}]` : ''}`);
    }
    if (forget) {
      lines.push('The remembered choice was cleared.');
    }
    if (session.pin === null) {
      lines.push('Currently not pinned (only one profile was open when connecting).');
    }
    lines.push('Call select_profile with a profile name to switch.');
    return lines.join('\n');
  }
  const dir = resolveProfileDir(target.userDataDir, profile);
  session.override = dir;
  if (remember) {
    writeRemembered(target, dir);
  }
  const browser = session.browser;
  const wasConnected = Boolean(browser?.connected);
  if (wasConnected) {
    await browser.disconnect().catch(() => {});
  }
  const env = process.env[PROFILE_ENV]?.trim();
  const envNote = env && !/^(auto|off|none|false|0)$/i.test(env) && remember ? ` Note: ${PROFILE_ENV}=${env} still applies to new sessions.` : '';
  return (
    `Chrome profile set to "${profileName(target.userDataDir, dir)}" (${dir})${remember ? ' and remembered for future sessions' : ' for this session'}.` +
    `${wasConnected ? ' Disconnected from Chrome; the next browser tool call reconnects (Chrome may ask "Allow remote debugging?" again).' : ''}${envNote}`
  );
}
