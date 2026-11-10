#!/usr/bin/env node
/**
 * Manual end-to-end test against your running Chrome (remote debugging enabled
 * in chrome://inspect/#remote-debugging). Every scenario that connects makes
 * Chrome show "Allow remote debugging?" — approve it.
 *
 *   node test/e2e.mjs offline
 *   node test/e2e.mjs fixed   "<profile>"                 # CHROME_DEVTOOLS_MCP_PROFILE
 *   node test/e2e.mjs elicit  "<profile A>" "<profile B>" # needs 2+ open profiles
 *   node test/e2e.mjs no-elicit                           # needs 2+ open profiles
 *
 * Uses a temporary state dir, so your remembered choice is not touched.
 */
import {spawn} from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [scenario = 'offline', a, b] = process.argv.slice(2);
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cdmcp-pin-test-'));

function startServer({env = {}, elicitAnswer} = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'launch.mjs'), '--autoConnect', '--no-usage-statistics'], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {...process.env, CHROME_DEVTOOLS_MCP_PROFILE_STATE_DIR: stateDir, ...env},
  });
  let stderr = '';
  child.stderr.on('data', d => (stderr += d));
  let buf = '';
  let id = 0;
  const pending = new Map();
  const write = msg => child.stdin.write(JSON.stringify(msg) + '\n');
  child.stdout.on('data', d => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const msg = JSON.parse(line);
      if (msg.method === 'elicitation/create') {
        console.log(`  <- elicitation: "${msg.params.message}" options=${JSON.stringify(msg.params.requestedSchema?.properties?.profile?.enumNames)}`);
        write({jsonrpc: '2.0', id: msg.id, result: elicitAnswer ? {action: 'accept', content: elicitAnswer} : {action: 'decline'}});
      } else if (msg.id !== undefined && pending.has(msg.id)) {
        pending.get(msg.id)(msg);
        pending.delete(msg.id);
      }
    }
  });
  const rpc = (method, params) =>
    new Promise(resolve => {
      const n = ++id;
      pending.set(n, resolve);
      write({jsonrpc: '2.0', id: n, method, params});
    });
  const call = async (name, args = {}) => {
    const msg = await rpc('tools/call', {name, arguments: args});
    if (msg.error) return `RPC ERROR ${JSON.stringify(msg.error)}`;
    const text = (msg.result.content ?? []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    return (msg.result.isError ? '[isError] ' : '') + text.replace(/https?:\/\/[^\s)]+/g, u => new URL(u).origin + '/…');
  };
  const init = async () => {
    await rpc('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: elicitAnswer !== undefined ? {elicitation: {form: {}}} : {},
      clientInfo: {name: 'profile-pin-e2e', version: '1'},
    });
    write({jsonrpc: '2.0', method: 'notifications/initialized'});
  };
  return {child, rpc, call, init, stderr: () => stderr};
}

const header = text => text.split('\n').find(l => l.startsWith('## Pages')) ?? text.split('\n')[0];

const scenarios = {
  async offline() {
    const s = startServer();
    await s.init();
    const tools = (await s.rpc('tools/list', {})).result.tools.map(t => t.name);
    console.log('select_profile registered:', tools.includes('select_profile'), `(${tools.length} tools)`);
    console.log('select_profile {}:\n' + (await s.call('select_profile')));
    return s;
  },
  async fixed() {
    const s = startServer({env: {CHROME_DEVTOOLS_MCP_PROFILE: a}});
    await s.init();
    console.log('list_pages:', header(await s.call('list_pages')));
    console.log('new_page:', header(await s.call('new_page', {url: 'data:text/html,<title>e2e-fixed</title>'})));
    return s;
  },
  async elicit() {
    const s = startServer({elicitAnswer: {profile: a, remember: true}});
    await s.init();
    console.log('list_pages:', header(await s.call('list_pages')));
    console.log('remembered:', fs.readFileSync(path.join(stateDir, 'state.json'), 'utf8').replace(/\s+/g, ' '));
    console.log('select_profile:', await s.call('select_profile', {profile: b, remember: false}));
    console.log('list_pages after switch:', header(await s.call('list_pages')));
    return s;
  },
  async 'no-elicit'() {
    const s = startServer();
    await s.init();
    console.log('list_pages:', (await s.call('list_pages')).slice(0, 400));
    return s;
  },
};

const s = await scenarios[scenario]();
console.log('server log:', (s.stderr().match(/\[profile-pin\][^\n]*/g) ?? []).join('\n  '));
s.child.kill();
fs.rmSync(stateDir, {recursive: true, force: true});
process.exit(0);
