#!/usr/bin/env node
'use strict';

const { spawn, execSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const { randomUUID, randomBytes } = require('crypto');

const { LogBus, paths: pathsOf } = require('./src/logbus');
const { startReverseProxy } = require('./src/reverse-proxy');
const { PluginManager } = require('./src/plugin-manager');
const { Signaler } = require('./src/signaler');
const { readRecords } = require('./src/logger');
const {
  readConfig, writeConfig, resolveConfig,
  setPluginEnabled, CONFIG_FILE, APP_DIR,
} = require('./src/config');

const DEFAULT_UPSTREAM = 'https://api.anthropic.com';

const HELP = `ccdiag — observability wrapper for Claude Code

Usage:
  ccdiag [options] [claude-args...]
  ccdiag <command>

Commands:
  log on                        Enable request logging for current directory
  log off                       Disable request logging for current directory
  log status                    Show current logging state
  plugin list                   List available plugins and their state
  plugin enable <name> [--app]  Enable a plugin
  plugin disable <name> [--app] Disable a plugin
  plugin init <name>            Scaffold a new plugin in cwd and enable it
  install                       Add ccdiag directory to user PATH

Options:
  --npx           Launch via npx instead of claude directly
  -h, --help      Show this help

Environment:
  CCDIAG_UPSTREAM_URL   Override upstream API URL
  CCDIAG_LOG_DIR        Override log directory (default: .ccdiag-logs)
  CCDIAG_BODY_LIMIT     Max body size to log in bytes (default: 1MB)
  CCDIAG_FORCE_PIPE     Force pipe mode for stdio (set to 1)

Config:
  ${CONFIG_FILE} in current directory or app directory (Ktav 0.6 format)
  CWD config overrides app config (${APP_DIR}).
  Logging is off by default; use "ccdiag log on" to enable.
  Plugins are enabled by default; use "ccdiag plugin disable <name>" to turn off.
`;

function handleSubcommand(args) {
  if (args[0] === '-h' || args[0] === '--help') {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (args[0] === 'log') {
    const sub = args[1];
    const cfg = readConfig();

    if (sub === 'on') {
      cfg.log = true;
      writeConfig(cfg);
      process.stdout.write(`[ccdiag] logging enabled (${CONFIG_FILE})\n`);
      process.exit(0);
    }
    if (sub === 'off') {
      cfg.log = false;
      writeConfig(cfg);
      process.stdout.write(`[ccdiag] logging disabled (${CONFIG_FILE})\n`);
      process.exit(0);
    }
    if (sub === 'status' || sub === undefined) {
      const on = cfg.log === true;
      process.stdout.write(`[ccdiag] logging: ${on ? 'on' : 'off'}\n`);
      process.exit(0);
    }

    process.stderr.write(`[ccdiag] unknown log subcommand: ${sub}\n`);
    process.exit(1);
  }

  if (args[0] === 'plugin') {
    const sub = args[1];
    const cfg = resolveConfig();
    const pm = new PluginManager(cfg, null, null);

    if (sub === 'list' || sub === undefined) {
      const list = pm.list();
      if (!list.length) {
        process.stdout.write('[ccdiag] no plugins found\n');
      } else {
        for (const p of list) {
          const tag = p.enabled ? 'on ' : 'off';
          const src = p.source !== 'builtin' ? ` (${p.source})` : '';
          process.stdout.write(`  [${tag}] ${p.name.padEnd(22)} ${p.description}${src}\n`);
        }
      }
      process.exit(0);
    }

    if (sub === 'enable' || sub === 'disable') {
      const name = args[2];
      if (!name) {
        process.stderr.write(`[ccdiag] usage: ccdiag plugin ${sub} <name> [--app]\n`);
        process.exit(1);
      }
      const known = pm.list().map(p => p.name);
      if (!known.includes(name)) {
        process.stderr.write(`[ccdiag] unknown plugin: ${name}\n`);
        process.stderr.write(`[ccdiag] available: ${known.join(', ')}\n`);
        process.exit(1);
      }
      const useApp = args.includes('--app');
      const dir = useApp ? APP_DIR : process.cwd();
      setPluginEnabled(dir, name, sub === 'enable');
      const label = useApp ? 'app' : 'cwd';
      process.stdout.write(`[ccdiag] plugin ${name}: ${sub}d (${label} ${CONFIG_FILE})\n`);
      process.exit(0);
    }

    if (sub === 'init') {
      const name = args[2];
      if (!name) {
        process.stderr.write('[ccdiag] usage: ccdiag plugin init <name>\n');
        process.exit(1);
      }
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        process.stderr.write('[ccdiag] plugin name must be lowercase alphanumeric with dashes\n');
        process.exit(1);
      }

      const cwdCfg = readConfig();
      const pluginsDir = cwdCfg['plugins.dir']
        || (cwdCfg.plugins && cwdCfg.plugins.dir)
        || '.ccdiag/plugins';
      const resolvedDir = path.resolve(process.cwd(), pluginsDir);

      fs.mkdirSync(resolvedDir, { recursive: true });

      const pluginFile = path.join(resolvedDir, `${name}.js`);
      if (fs.existsSync(pluginFile)) {
        process.stderr.write(`[ccdiag] plugin file already exists: ${pluginFile}\n`);
        process.exit(1);
      }

      const template = `'use strict';

module.exports = {
  name: '${name}',
  description: 'TODO: describe what this plugin does',
  defaultEnabled: true,

  init(api) {
    // api.signal(finding)  — emit a finding to the signaler
    // api.log(event, data) — write to the event log
    // api.config            — plugin-specific config from .ccdiag.ktav
    // api.bus               — raw LogBus instance

    return {
      onRequest(ctx) {
        // ctx.method, ctx.url, ctx.headers, ctx.bodyBuffer
        // ctx.json(), ctx.setJson(obj), ctx.setBody(buf)
      },

      onResponseHead(ctx) {
        // ctx.statusCode, ctx.headers, ctx.isStream, ctx.request
      },

      onSseEvent(ctx) {
        // ctx.eventType, ctx.data, ctx.rawData
        // ctx.setData(obj) to mutate
      },

      onResponseBody(ctx) {
        // ctx.statusCode, ctx.headers, ctx.bodyBuffer
        // ctx.json(), ctx.setJson(obj), ctx.setBody(buf)
      },

      evaluate() {
        // return { kind: '${name}.something', reason: '...' } or null
        return null;
      },
    };
  },
};
`;

      fs.writeFileSync(pluginFile, template);

      if (!cwdCfg['plugins.dir'] && !(cwdCfg.plugins && cwdCfg.plugins.dir)) {
        if (!cwdCfg.plugins) cwdCfg.plugins = {};
        cwdCfg.plugins.dir = pluginsDir;
      }
      if (!cwdCfg.plugin) cwdCfg.plugin = {};
      if (!cwdCfg.plugin[name]) cwdCfg.plugin[name] = {};
      cwdCfg.plugin[name].enabled = true;
      writeConfig(cwdCfg);

      process.stdout.write(`[ccdiag] created ${pluginFile}\n`);
      process.stdout.write(`[ccdiag] plugin ${name}: enabled (cwd ${CONFIG_FILE})\n`);
      process.stdout.write(`[ccdiag] plugins.dir: ${pluginsDir}\n`);
      process.exit(0);
    }

    process.stderr.write(`[ccdiag] unknown plugin subcommand: ${sub}\n`);
    process.exit(1);
  }

  if (args[0] === 'install') {
    const ccdiagDir = path.resolve(__dirname, 'bin');
    const isWin = process.platform === 'win32';

    if (isWin) {
      let currentPath = '';
      try {
        const raw = execSync('reg query "HKCU\\Environment" /v Path', { encoding: 'utf8' });
        const m = raw.match(/REG_(?:EXPAND_)?SZ\s+(.*)/);
        if (m) currentPath = m[1].trim();
      } catch (_) {}

      const parts = currentPath.split(';').map(p => p.toLowerCase());
      if (parts.includes(ccdiagDir.toLowerCase())) {
        process.stdout.write('[ccdiag] Already in PATH.\n');
        process.exit(0);
      }

      const newPath = currentPath ? `${currentPath};${ccdiagDir}` : ccdiagDir;
      try {
        execSync(`setx PATH "${newPath}"`, { stdio: 'pipe' });
      } catch (e) {
        process.stderr.write(`[ccdiag] Failed to update PATH: ${e.message}\n`);
        process.exit(1);
      }
      process.stdout.write(`[ccdiag] Added to user PATH. Restart your terminal.\n`);
      process.exit(0);
    }

    // Unix: detect shell profile
    const shell = path.basename(process.env.SHELL || '/bin/bash');
    const home = process.env.HOME || '~';
    let profile;
    if (shell === 'zsh') {
      profile = fs.existsSync(path.join(home, '.zshrc'))
        ? path.join(home, '.zshrc') : path.join(home, '.zprofile');
    } else if (shell === 'fish') {
      profile = path.join(home, '.config', 'fish', 'config.fish');
    } else {
      if (fs.existsSync(path.join(home, '.bashrc'))) profile = path.join(home, '.bashrc');
      else if (fs.existsSync(path.join(home, '.bash_profile'))) profile = path.join(home, '.bash_profile');
      else profile = path.join(home, '.profile');
    }

    const pathEnv = process.env.PATH || '';
    if (pathEnv.split(':').includes(ccdiagDir)) {
      process.stdout.write('[ccdiag] Already in PATH.\n');
      process.exit(0);
    }

    if (fs.existsSync(profile)) {
      const content = fs.readFileSync(profile, 'utf8');
      if (content.includes(ccdiagDir)) {
        process.stdout.write(`[ccdiag] Already in ${profile} (restart your terminal).\n`);
        process.exit(0);
      }
    }

    const line = shell === 'fish'
      ? `set -gx PATH $PATH ${ccdiagDir}`
      : `export PATH="$PATH:${ccdiagDir}"`;
    fs.appendFileSync(profile, `\n# ccdiag\n${line}\n`);
    process.stdout.write(`[ccdiag] Added to ${profile}\n`);
    process.stdout.write(`[ccdiag] Run: source ${profile}\n`);
    process.exit(0);
  }

  return false;
}

async function main() {
  const rawArgs = process.argv.slice(2);
  if (handleSubcommand(rawArgs)) return;

  const useNpx = rawArgs.includes('--npx');
  const args = rawArgs.filter(a => a !== '--npx');

  const cfg = resolveConfig();
  const nolog = cfg.log !== true;
  const sessionId = randomUUID();

  const rootDir = process.env.CCDIAG_LOG_DIR
    || path.join(process.cwd(), '.ccdiag-logs');
  const sessionDir = path.join(rootDir, sessionId);

  if (!nolog) fs.mkdirSync(sessionDir, { recursive: true });

  const bus = new LogBus(sessionDir, { sid: sessionId, source: 'wrapper' }, { disabled: nolog });
  const sessionPaths = nolog ? null : pathsOf(sessionDir);

  const upstreamUrl = process.env.CCDIAG_UPSTREAM_URL
    || process.env.ANTHROPIC_BASE_URL
    || DEFAULT_UPSTREAM;

  const meta = {
    sid: sessionId,
    started_at: new Date().toISOString(),
    cwd: process.cwd(),
    argv: args,
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    upstream_url: upstreamUrl,
    env_keys: Object.keys(process.env).filter(k =>
      /^(ANTHROPIC|CLAUDE|CCDIAG)_/i.test(k)
    ),
  };
  if (sessionPaths) fs.writeFileSync(sessionPaths.meta, JSON.stringify(meta, null, 2));
  bus.event('session.start', meta);

  const plugins = new PluginManager(cfg, bus, sessionId);
  plugins.init();
  const signaler = new Signaler(bus);

  const gateToken = randomBytes(32).toString('hex');

  const { port: proxyPort, stop: stopProxy } = await startReverseProxy(bus, {
    upstreamUrl,
    plugins,
    gateToken,
    onFindings(findings) {
      signaler.observe(findings);
    },
  });
  const localUrl = `http://127.0.0.1:${proxyPort}/gate_${gateToken}`;

  const isWin = process.platform === 'win32';
  let baseCmd, baseArgs;
  if (useNpx) {
    baseCmd = isWin ? 'npx.cmd' : 'npx';
    baseArgs = ['--yes', '@anthropic-ai/claude-code', ...args];
  } else {
    baseCmd = isWin ? 'claude.cmd' : 'claude';
    baseArgs = args;
  }

  const childEnv = Object.assign({}, process.env, {
    ANTHROPIC_BASE_URL: localUrl,
    CCDIAG_SESSION_DIR: sessionDir,
    CCDIAG_SESSION_ID: sessionId,
  });
  delete childEnv.HTTP_PROXY;
  delete childEnv.HTTPS_PROXY;
  delete childEnv.http_proxy;
  delete childEnv.https_proxy;

  let spawnCmd, spawnArgs, extraSpawnOpts;
  if (isWin) {
    spawnCmd = process.env.ComSpec || 'cmd.exe';
    const quoteCmd = a => /[\s"&|<>^()%!]/.test(String(a))
      ? '"' + String(a).replace(/"/g, '""') + '"'
      : String(a);
    spawnArgs = ['/d', '/s', '/c', [baseCmd, ...baseArgs].map(quoteCmd).join(' ')];
    extraSpawnOpts = { windowsVerbatimArguments: true };
  } else {
    spawnCmd = baseCmd;
    spawnArgs = baseArgs;
    extraSpawnOpts = {};
  }

  const inheritStdio = !!(process.stdout.isTTY && process.stderr.isTTY)
    && process.env.CCDIAG_FORCE_PIPE !== '1';

  bus.event('child.spawn', {
    cmd: baseCmd,
    args: baseArgs,
    upstream: upstreamUrl,
    local_endpoint: localUrl,
    session_dir: sessionDir,
    stdio_mode: inheritStdio ? 'inherit' : 'pipe',
    plugins_active: plugins.active.map(p => p.name),
  });

  const startTime = Date.now();
  const child = spawn(spawnCmd, spawnArgs, Object.assign({
    env: childEnv,
    stdio: inheritStdio ? 'inherit' : ['inherit', 'pipe', 'pipe'],
    windowsHide: false,
  }, extraSpawnOpts));

  let stdoutBytes = 0, stderrBytes = 0;

  if (!inheritStdio) {
    child.stdout.on('data', chunk => {
      stdoutBytes += chunk.length;
      process.stdout.write(chunk);
      bus.event('child.stdout', {
        bytes: chunk.length,
        sample: chunk.slice(0, 256).toString('utf8'),
      });
    });
    child.stderr.on('data', chunk => {
      stderrBytes += chunk.length;
      process.stderr.write(chunk);
      bus.event('child.stderr', {
        bytes: chunk.length,
        sample: chunk.slice(0, 256).toString('utf8'),
      });
    });
  }

  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
    process.on(sig, () => {
      bus.event('wrapper.signal', { signal: sig });
      try { child.kill(sig); } catch (_) {}
    });
  }

  child.on('error', err => {
    bus.event('child.error', { error: err.message, code: err.code });
  });

  child.on('exit', async (code, signal) => {
    const duration = Date.now() - startTime;
    bus.event('child.exit', {
      code, signal,
      duration_ms: duration,
      stdout_bytes: stdoutBytes,
      stderr_bytes: stderrBytes,
    });

    let summary;
    if (sessionPaths) {
      try {
        summary = buildSummary(sessionPaths, {
          sessionId,
          upstream_url: upstreamUrl,
          duration_ms: duration,
          exit_code: code,
          exit_signal: signal,
        });
      } catch (e) {
        summary = { error: String(e && e.message || e) };
      }

      try {
        fs.writeFileSync(sessionPaths.summary, JSON.stringify(summary, null, 2));
      } catch (_) {}
      bus.event('session.end', { summary_path: sessionPaths.summary });
    }

    process.stderr.write(`\n[ccdiag] upstream: ${upstreamUrl}  local: ${localUrl}\n`);
    if (sessionPaths) process.stderr.write(`[ccdiag] session: ${sessionDir}\n`);
    if (summary && summary.requests) {
      process.stderr.write(
        `[ccdiag] requests=${summary.requests.total}` +
        ` errors=${summary.requests.errors}` +
        ` 5xx=${summary.requests.status_5xx}` +
        ` retries_suspected=${summary.requests.retries_suspected}` +
        ` bytes_up=${summary.requests.total_bytes_up}` +
        ` bytes_down=${summary.requests.total_bytes_down}\n`
      );
      if (summary.signals_count > 0) {
        process.stderr.write(`[ccdiag] SIGNALS RAISED: ${summary.signals_count} (see signals.json5l)\n`);
      }
    }

    try {
      await Promise.race([
        stopProxy(),
        new Promise(r => setTimeout(r, 2000).unref?.()),
      ]);
    } catch (_) {}

    const exitCode = code == null ? 0 : code;
    if (signal && code == null) {
      try { process.kill(process.pid, signal); } catch (_) {}
    }
    process.exit(exitCode);
  });
}

function buildSummary(sessionPaths, base) {
  const summary = Object.assign({}, base, {
    requests: {
      total: 0,
      by_host: {},
      by_status: {},
      status_5xx: 0,
      errors: 0,
      total_bytes_up: 0,
      total_bytes_down: 0,
      retries_suspected: 0,
      ratelimit_last: null,
    },
    signals_count: 0,
    signals: [],
  });

  const fingerprintCounts = {};
  for (const r of readRecords(sessionPaths.requests)) {
    if (r.phase === 'start') {
      summary.requests.total++;
      if (r.host) summary.requests.by_host[r.host] = (summary.requests.by_host[r.host] || 0) + 1;
      const fp = `${r.method || ''}|${r.host || ''}|${r.path || ''}|${r.body_hash || ''}`;
      fingerprintCounts[fp] = (fingerprintCounts[fp] || 0) + 1;
    }
    if (r.phase === 'end') {
      if (typeof r.status === 'number') {
        summary.requests.by_status[r.status] = (summary.requests.by_status[r.status] || 0) + 1;
        if (r.status >= 500) summary.requests.status_5xx++;
      }
      if (r.bytes_up) summary.requests.total_bytes_up += r.bytes_up;
      if (r.bytes_down) summary.requests.total_bytes_down += r.bytes_down;
      if (r.ratelimit && Object.keys(r.ratelimit).length) summary.requests.ratelimit_last = r.ratelimit;
    }
    if (r.phase === 'error') summary.requests.errors++;
  }
  for (const fp of Object.keys(fingerprintCounts)) {
    if (fingerprintCounts[fp] > 1) summary.requests.retries_suspected += fingerprintCounts[fp] - 1;
  }

  for (const s of readRecords(sessionPaths.signals)) {
    summary.signals_count++;
    summary.signals.push({ kind: s.kind, reason: s.reason, ts: s.ts });
  }

  return summary;
}

main().catch(err => {
  process.stderr.write(`[ccdiag] fatal: ${err && err.stack || err}\n`);
  process.exit(1);
});
