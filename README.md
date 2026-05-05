# ccdiag

Observability wrapper for [Claude Code](https://docs.anthropic.com/en/docs/claude-code). Intercepts all API traffic through a local reverse proxy, logs requests/responses, and detects anomalies (retry storms, request loops, tool call loops, rate bursts) via a plugin system.

## Install

### npm (recommended)

```bash
npm install -g ccdiag
```

After install, `ccdiag` and `ccdiagy` are available globally.

### From source

```bash
git clone https://github.com/PHPCraftdream/ccdiag.git
cd ccdiag
npm install
node index.js install   # adds bin/ to PATH (Windows setx, Unix shell profile)
```

## Usage

```bash
# Launch Claude Code through the proxy
node index.js

# Or use the launcher scripts (after `ccdiag install`)
ccdiag                        # Linux/macOS
ccdiag.bat                    # Windows

# Launch with all permissions skipped
ccdiagy                       # Linux/macOS
ccdiagy.bat                   # Windows

# Use npx instead of local claude binary
node index.js --npx
```

## Commands

```bash
ccdiag log on                          # Enable request logging to disk
ccdiag log off                         # Disable logging (default)
ccdiag log status                      # Show current state

ccdiag plugin list                     # List plugins and their state
ccdiag plugin enable <name>            # Enable a plugin (cwd config)
ccdiag plugin disable <name>           # Disable a plugin (cwd config)
ccdiag plugin enable <name> --app      # Enable in app-wide config
ccdiag plugin init <name>              # Scaffold a new plugin in cwd

ccdiag install                         # Add ccdiag to user PATH
```

## Config

Settings are stored in `.ccdiag.ktav` ([Ktav 0.6](https://github.com/ktav-lang/js) format). Two config locations are merged (cwd overrides app directory):

```
log: true
plugin.retry-storm.enabled: true
plugin.tool-loop.enabled: true
plugin.rate-burst.enabled: false
plugin.retry-storm.windowMs: 30000
plugin.retry-storm.threshold: 5
```

See `.ccdiag.ktav.example` for a full annotated example.

## Plugins

Built-in plugins detect anomalies inline in the proxy — no file-tail lag, works even with logging off:

| Plugin | Detects |
|---|---|
| `retry-storm` | Repeated 5xx responses to the same endpoint |
| `identical-request` | Identical request bodies sent repeatedly |
| `tool-loop` | Claude calling the same tool with same input in a loop |
| `rate-burst` | Sudden burst of outgoing requests |

Plugins can read and mutate requests, response headers, SSE events, and response bodies.

### External plugins

Scaffold a new plugin in the current directory:

```bash
ccdiag plugin init my-analyzer
```

This creates `.ccdiag/plugins/my-analyzer.js` with a full template, sets `plugins.dir` in local config, and enables the plugin.

You can also place `.js` files manually in a directory and point to it in config:

```
plugins.dir: .ccdiag/plugins
```

External plugins use the same API as built-in ones. See `src/plugins/` for examples.

## Environment

| Variable | Description |
|---|---|
| `CCDIAG_UPSTREAM_URL` | Override upstream API URL |
| `CCDIAG_LOG_DIR` | Override log directory (default: `.ccdiag-logs`) |
| `CCDIAG_BODY_LIMIT` | Max body size to log in bytes (default: 1MB) |
| `CCDIAG_FORCE_PIPE` | Force pipe mode for stdio (`1`) |

## Scripts

```bash
node scripts/agent-invocations.js [log-dir]   # Analyze Agent subagent usage across sessions
```

## How it works

1. Starts a reverse proxy on `127.0.0.1` (random port)
2. Launches Claude Code with `ANTHROPIC_BASE_URL` pointing to the proxy
3. All API traffic flows through the proxy, where plugins can observe and mutate it
4. When logging is enabled, requests/responses are written to `.ccdiag-logs/<session-id>/`
5. On exit, prints a summary to stderr

## License

MIT OR Apache-2.0
