# chrome-devtools-mcp-profile-pin

Make [chrome-devtools-mcp](https://github.com/ChromeDevTools/chrome-devtools-mcp) work with **one Chrome profile of your choice** when several Chrome profiles are open.

The wrapper patches your globally installed chrome-devtools-mcp in a separate copy, so the original install stays untouched. It **re-applies itself automatically after every update** of chrome-devtools-mcp.

> Unofficial, not affiliated with Google. Upstream discussion: [ChromeDevTools/chrome-devtools-mcp#694](https://github.com/ChromeDevTools/chrome-devtools-mcp/issues/694).

## The problem

With `--autoConnect`, all open Chrome profiles share one browser process and one debugging endpoint. Chrome reports the **last-focused profile** as its default browser context, and that value changes as you switch windows. As a result:

- the server binds to whichever profile happened to have focus when it connected;
- `list_pages` mixes tabs from several profiles;
- `new_page` opens in whichever profile has focus at that moment.

## What you get

- **The server sees exactly one profile.** Pages, workers, service workers, console and network of other profiles are never attached.
- **It asks only when it has to.** If only one profile has open windows, nothing changes. If several are open, you are asked which one to use, with one choice per profile, and the answer is remembered. The question comes either as an MCP elicitation form or, where the client can't show forms, from the agent itself (see below).
- **You can see which profile is attached.** `list_pages` shows it in the header, e.g. `## Pages (Chrome profile: Work (Profile 1))`.
- **A `select_profile` tool.** Ask the agent to "switch to my work profile". With no arguments, the tool lists your profiles.
- **New tabs always open in the attached profile.** If that profile is closed, its window is opened for you.

### How the profile is chosen

The first matching rule wins:

1. `select_profile` was called in this session.
2. The `CHROME_DEVTOOLS_MCP_PROFILE` environment variable is set to a display name or folder name. Set it to `off` to disable pinning completely.
3. Only one profile has open windows: no pinning, same as upstream.
4. You chose a profile earlier and asked to remember it.
5. The client shows an MCP elicitation form: a single-select list of your profiles.
6. Otherwise the tool call returns a message that lists each profile with the exact `select_profile` call for it. It tells the agent to ask you with one choice per profile. In Claude Code, for example, the agent asks with one button per profile, and the call is retried after you pick one.

Some clients advertise elicitation but have no UI for it and decline automatically. The Claude desktop app's Code tab runs Claude Code in SDK/print mode and does this. In that case the wrapper falls back to step 6.

## Requirements

- Node.js **22.12+**. The wrapper uses Node's built-in `WebSocket`.
- Google Chrome 144+, with remote debugging enabled at `chrome://inspect/#remote-debugging` (the normal `--autoConnect` setup).
- chrome-devtools-mcp installed **globally**:
  ```bash
  npm install -g chrome-devtools-mcp@latest
  ```

Tested with chrome-devtools-mcp 1.12.0 and Chrome 157 on Windows. The macOS and Linux code paths exist but are untested.

## Installation

1. Clone the repository somewhere permanent:
   ```bash
   git clone https://github.com/shraga100/chrome-devtools-mcp-profile-pin.git
   ```
2. Point your MCP client at `launch.mjs` instead of chrome-devtools-mcp, and keep your usual flags.

   **Claude Code:**
   ```bash
   claude mcp add chrome-devtools --scope user -- node /path/to/chrome-devtools-mcp-profile-pin/launch.mjs --autoConnect
   ```

   **Any client using JSON config** (`~/.claude.json`, `.mcp.json`, Cursor, etc.):
   ```json
   {
     "mcpServers": {
       "chrome-devtools": {
         "command": "node",
         "args": ["/path/to/chrome-devtools-mcp-profile-pin/launch.mjs", "--autoConnect"]
       }
     }
   }
   ```
   To always use one profile, add `"env": { "CHROME_DEVTOOLS_MCP_PROFILE": "Work" }`.
3. Start a new session. On first start the wrapper builds the patched copy into `dist/`, which takes a few seconds.

Sessions that are already running keep using whatever they started with. Only new sessions use the wrapper.

## Staying patched after chrome-devtools-mcp updates

You don't need to do anything special. Update chrome-devtools-mcp as usual:

```bash
npm install -g chrome-devtools-mcp@latest
```

On the next start, `launch.mjs` notices the new version, builds a fresh patched copy in `dist/<version>-<hash>/` and runs it. Old copies are kept for 14 days, because long-running sessions may still be using them, and are then deleted.

If a new upstream version changed the code the patch relies on, the wrapper **does not break your MCP**. It logs a warning to stderr and runs the unpatched upstream server, so you only lose profile pinning. Check for an update of this repository:

```bash
git pull
```

To check the status manually:

```bash
node build.mjs           # build if needed and print status
node build.mjs --force   # rebuild
```

## Configuration

| Environment variable | Meaning |
|---|---|
| `CHROME_DEVTOOLS_MCP_PROFILE` | Profile to use: a display name (`Work`) or folder name (`Profile 1`). `auto` (default) or `off`. |
| `CHROME_DEVTOOLS_MCP_CHROME_PATH` | Chrome executable, if it isn't found automatically. |
| `CHROME_DEVTOOLS_MCP_SOURCE` | Path of the chrome-devtools-mcp package to patch, if it isn't the global npm one. |
| `CHROME_DEVTOOLS_MCP_PROFILE_STATE_DIR` | Where the remembered choice is stored. Default: `~/.chrome-devtools-mcp-profile-pin`. |

The `select_profile` tool takes these arguments:

- `profile`: the profile to switch to.
- `remember`: default `true`.
- `forget`: clears the remembered choice.

Switching reconnects to Chrome, so Chrome may show "Allow remote debugging?" again.

## How it works

- The wrapper opens **one** WebSocket to Chrome, so the consent dialog appears once. It resolves the profile on that socket and then hands the same socket to Puppeteer through `puppeteer.connect({transport})`.
- To find a profile's `browserContextId`, it runs `chrome --profile-directory=<dir> "data:text/html,<!--nonce-->"`. The running Chrome opens that tab inside the profile, opening the profile's window if needed, and the wrapper looks for the nonce in `Target.targetCreated`. It runs no script in your pages. If the profile already has other tabs, the helper tab is closed again. A running Chrome ignores `about:` and `chrome://` URLs from the command line, which is why the helper tab uses a `data:` URL.
- Puppeteer's `targetFilter` rejects targets whose `browserContextId` belongs to another profile.
- `new_page` first tries `Target.createTarget({browserContextId})`. Chrome only accepts that while the profile is the last-focused one, so on failure the wrapper falls back to the command-line trick.
- The patch is applied to the built JavaScript with exact-match anchors (`lib/patch.mjs`). If any anchor is missing, the build fails as a whole rather than half-applying.

## Limitations

- Chrome still asks "Allow remote debugging?" on every new connection. This wrapper doesn't change that.
- When a pinned session connects, the profile's window comes to the front, and a helper tab may stay open if the profile had no other tabs.
- When `new_page` uses the fallback, `background: true` can't be honoured.
- If every window of the pinned profile is closed while connected, the next `new_page` reconnects. Chrome gives the reopened profile a new id.
- Only local Chrome connections are supported (`--autoConnect`, or `--browserUrl` pointing at localhost).

## Testing

`test/e2e.mjs` drives the server over stdio against your real Chrome. It uses a temporary state directory, so your remembered choice is not touched.

```bash
node test/e2e.mjs offline
node test/e2e.mjs fixed "Work"
node test/e2e.mjs elicit "Profile 1" "Default"   # 2+ profiles must be open
node test/e2e.mjs no-elicit                      # 2+ profiles must be open
```

## License

Apache-2.0, the same as chrome-devtools-mcp.
