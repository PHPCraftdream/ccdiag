# ccdiag

Observability wrapper for Claude Code CLI. Reverse proxy intercepts all API traffic, plugins analyze and can mutate requests/responses inline.

## Architecture

```
index.js              Entry point, CLI commands, child process management
src/
  reverse-proxy.js    HTTP reverse proxy with inline plugin hooks
  plugin-manager.js   Plugin discovery (builtin + external), lifecycle, dispatch
  plugins/            Built-in plugins (one file per plugin)
    _window.js        Shared sliding-window utility
    retry-storm.js    Detects repeated 5xx responses
    identical-request.js  Detects identical request bodies
    tool-loop.js      Detects repeated tool_use calls via SSE parsing
    rate-burst.js     Detects request bursts
  config.js           Ktav 0.6 config: read/write/merge app-dir + cwd
  logbus.js           Log routing to 4 json5l files (events, requests, signals, files)
  logger.js           Json5Logger with redaction, record separator "---\n"
  signaler.js         Deduplicates findings, prints stderr banners
  redact.js           Secret scrubbing (API keys, tokens, env values)
scripts/              Post-session analysis utilities
bin/                  Launcher scripts (ccdiag, ccdiagy) for PATH
test/                 Unit tests (node:test)
.github/workflows/    CI (syntax check + smoke test + unit tests)
```

## Key conventions

- Node.js, CommonJS (`require`), no TypeScript, no transpilation
- Single dependency besides native: `json5` for log format, `@ktav-lang/ktav` for config
- Config format: Ktav 0.6 (`.ccdiag.ktav`), dotted keys for nesting
- Log format: JSON5 records separated by `---\n` in `.json5l` files
- All sensitive data is redacted before writing to disk (see `src/redact.js`)
- Plugins are trusted internal code — they see data before redaction

## Plugin API

```js
module.exports = {
  name: 'my-plugin',
  description: 'What it does',
  defaultEnabled: true,
  init(api) {
    // api.signal(finding), api.log(event, data), api.config, api.bus
    return {
      onRequest(ctx) {},       // read/mutate: ctx.headers, ctx.bodyBuffer, ctx.json(), ctx.setJson()
      onResponseHead(ctx) {},  // read/mutate: ctx.statusCode, ctx.headers
      onSseEvent(ctx) {},      // read/mutate: ctx.data, ctx.setData()
      onResponseBody(ctx) {},  // read/mutate: ctx.bodyBuffer, ctx.json(), ctx.setJson()
      evaluate() {},           // return finding object or null
    };
  },
};
```

## Running and testing

```bash
node index.js                    # Launch claude through proxy
node index.js --help             # Show all commands
node index.js plugin list        # List plugins
node index.js plugin init foo    # Scaffold a new plugin in cwd
node index.js log on             # Enable disk logging for cwd
npm test                         # Run unit tests (node:test)
```

CI runs on push/PR: syntax check on all .js files, smoke test (`plugin list`), and `npm test` across Node 18/20/22.

## Platform notes

- Windows: `cmd.exe` spawn with `windowsVerbatimArguments`, `bin/*.bat` launchers
- Unix: direct spawn, `bin/ccdiag` and `bin/ccdiagy` launchers
- Proxy always binds to `127.0.0.1:0` (random port), gate token required
