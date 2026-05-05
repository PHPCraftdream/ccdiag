'use strict';

const fs = require('fs');
const path = require('path');
const { loads } = require('@ktav-lang/ktav');

const CONFIG_FILE = '.ccdiag.ktav';
const APP_DIR = path.resolve(__dirname, '..');

function configPath(dir) {
  return path.join(dir || process.cwd(), CONFIG_FILE);
}

function readConfigFile(dir) {
  const p = configPath(dir);
  try {
    return loads(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return {};
  }
}

function resolveConfig(cwd) {
  cwd = cwd || process.cwd();
  const appCfg = path.resolve(cwd) === path.resolve(APP_DIR)
    ? {} : readConfigFile(APP_DIR);
  const cwdCfg = readConfigFile(cwd);
  return Object.assign({}, appCfg, cwdCfg);
}

function readConfig(dir) {
  return readConfigFile(dir);
}

function dumpFlat(obj) {
  const flat = flattenDotted(obj);
  const lines = [];
  for (const k of Object.keys(flat)) {
    const v = flat[k];
    if (v === true) lines.push(`${k}: true`);
    else if (v === false) lines.push(`${k}: false`);
    else if (typeof v === 'number') lines.push(`${k}: ${v}`);
    else if (Array.isArray(v)) lines.push(`${k}: [${v.join(', ')}]`);
    else lines.push(`${k}: ${v}`);
  }
  return lines.join('\n') + '\n';
}

function writeConfig(obj, dir) {
  fs.writeFileSync(configPath(dir), dumpFlat(obj));
}

function isPluginEnabled(cfg, name, defaultEnabled) {
  const key = `plugin.${name}.enabled`;
  const flat = flattenDotted(cfg);
  if (key in flat) return flat[key] === true;
  return defaultEnabled === true;
}

function setPluginEnabled(dir, name, enabled) {
  const cfg = readConfigFile(dir);
  if (!cfg.plugin) cfg.plugin = {};
  if (!cfg.plugin[name]) cfg.plugin[name] = {};
  cfg.plugin[name].enabled = enabled;
  writeConfig(cfg, dir);
}

function flattenDotted(obj, prefix, out) {
  if (!out) out = {};
  if (!prefix) prefix = '';
  if (obj == null || typeof obj !== 'object' || Array.isArray(obj)) return out;
  for (const k of Object.keys(obj)) {
    const full = prefix ? `${prefix}.${k}` : k;
    const v = obj[k];
    if (v != null && typeof v === 'object' && !Array.isArray(v)) {
      flattenDotted(v, full, out);
    } else {
      out[full] = v;
    }
  }
  return out;
}

function pluginConfig(cfg, name) {
  const flat = flattenDotted(cfg);
  const prefix = `plugin.${name}.`;
  const out = {};
  for (const k of Object.keys(flat)) {
    if (k.startsWith(prefix) && k !== `${prefix}enabled`) {
      out[k.slice(prefix.length)] = flat[k];
    }
  }
  return out;
}

module.exports = {
  readConfig, writeConfig, resolveConfig,
  isPluginEnabled, setPluginEnabled, pluginConfig,
  flattenDotted, CONFIG_FILE, APP_DIR,
};
