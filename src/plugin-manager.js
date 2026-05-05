'use strict';

const fs = require('fs');
const path = require('path');
const { isPluginEnabled, pluginConfig } = require('./config');

const BUILTIN_DIR = path.join(__dirname, 'plugins');

function loadPluginsFromDir(dir) {
  let files;
  try { files = fs.readdirSync(dir); } catch (_) { return []; }
  const plugins = [];
  for (const f of files.filter(f => f.endsWith('.js') && !f.startsWith('_'))) {
    try {
      const mod = require(path.resolve(dir, f));
      if (mod && mod.name && typeof mod.init === 'function') plugins.push(mod);
    } catch (_) {}
  }
  return plugins;
}

function discoverPlugins(cfg) {
  const builtin = loadPluginsFromDir(BUILTIN_DIR);
  for (const p of builtin) p._source = 'builtin';
  const seen = new Set(builtin.map(p => p.name));

  const flat = require('./config').flattenDotted(cfg || {});
  const extDir = flat['plugins.dir'];
  let external = [];
  if (extDir) {
    const resolved = path.resolve(process.cwd(), extDir);
    if (resolved !== path.resolve(BUILTIN_DIR)) {
      external = loadPluginsFromDir(resolved).filter(p => !seen.has(p.name));
      for (const p of external) p._source = extDir;
    }
  }

  return [...builtin, ...external];
}

class PluginManager {
  constructor(cfg, bus, sessionId) {
    this.cfg = cfg;
    this.bus = bus;
    this.sessionId = sessionId;
    this.active = [];
    this.available = discoverPlugins(cfg);
    this._fired = new Set();
  }

  init() {
    for (const mod of this.available) {
      if (!isPluginEnabled(this.cfg, mod.name, mod.defaultEnabled)) continue;
      const api = {
        signal: (finding) => this._onSignal(finding),
        log: (event, data) => this.bus.event(`plugin.${mod.name}.${event}`, data),
        config: pluginConfig(this.cfg, mod.name),
        sessionId: this.sessionId,
        bus: this.bus,
      };
      try {
        const instance = mod.init(api);
        this.active.push({ name: mod.name, instance, mod });
      } catch (e) {
        this.bus.event('plugin.init_error', { plugin: mod.name, error: e.message });
      }
    }
  }

  _onSignal(finding) {
    if (!finding || this._fired.has(finding.kind)) return;
    this._fired.add(finding.kind);
    this._pendingSignals = this._pendingSignals || [];
    this._pendingSignals.push(finding);
  }

  _dispatch(hook, ctx) {
    for (const p of this.active) {
      if (typeof p.instance[hook] !== 'function') continue;
      try {
        p.instance[hook](ctx);
      } catch (e) {
        this.bus.event('plugin.hook_error', { plugin: p.name, hook, error: e.message });
      }
    }
  }

  onRequest(ctx) { this._dispatch('onRequest', ctx); }
  onResponseHead(ctx) { this._dispatch('onResponseHead', ctx); }
  onSseEvent(ctx) { this._dispatch('onSseEvent', ctx); }
  onResponseBody(ctx) { this._dispatch('onResponseBody', ctx); }

  evaluate() {
    const findings = [];
    for (const p of this.active) {
      if (typeof p.instance.evaluate !== 'function') continue;
      try {
        const f = p.instance.evaluate();
        if (f) this._onSignal(f);
      } catch (e) {
        this.bus.event('plugin.evaluate_error', { plugin: p.name, error: e.message });
      }
    }
    const out = this._pendingSignals || [];
    this._pendingSignals = [];
    return out;
  }

  wantsSse() {
    return this.active.some(p =>
      typeof p.instance.onSseEvent === 'function'
    );
  }

  list() {
    return this.available.map(mod => ({
      name: mod.name,
      description: mod.description || '',
      enabled: isPluginEnabled(this.cfg, mod.name, mod.defaultEnabled),
      defaultEnabled: mod.defaultEnabled === true,
      source: mod._source || 'builtin',
    }));
  }
}

module.exports = { PluginManager, discoverPlugins };
