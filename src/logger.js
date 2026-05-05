'use strict';

const fs = require('fs');
const path = require('path');
const JSON5 = require('json5');
const { makeScrubber, redactObject } = require('./redact');

const RECORD_SEPARATOR = '---\n';

class Json5Logger {
  constructor(filePath, meta = {}, options = {}) {
    this.filePath = filePath;
    this.meta = meta;
    this.disabled = options.disabled === true;
    this.scrub = options.scrub || makeScrubber(process.env);
    this.redact = options.redact !== false;
    if (!this.disabled) {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
      } catch (_) {}
    }
  }

  log(event, data) {
    if (this.disabled) return;
    const rec = Object.assign(
      { ts: new Date().toISOString(), pid: process.pid },
      this.meta,
      { event },
      data || {}
    );
    const safe = this.redact ? redactObject(rec, this.scrub) : rec;
    const sanitized = sanitizeForJson5(safe);
    let chunk;
    try {
      chunk = JSON5.stringify(sanitized, null, 2) + '\n' + RECORD_SEPARATOR;
    } catch (e) {
      try {
        chunk = JSON5.stringify({
          ts: rec.ts, pid: rec.pid, event: 'logger.serialize_error',
          original_event: event, error: String(e && e.message || e),
        }, null, 2) + '\n' + RECORD_SEPARATOR;
      } catch (_) {
        chunk = `{ event: "logger.fatal" }\n${RECORD_SEPARATOR}`;
      }
    }
    try {
      fs.appendFileSync(this.filePath, chunk);
    } catch (_) {}
  }
}

function sanitizeForJson5(value, depth) {
  if (depth == null) depth = 0;
  if (depth > 50) return '[deep]';
  if (value === null || value === undefined) return null;
  if (Buffer.isBuffer(value)) return { __buffer: true, length: value.length };
  if (value instanceof Uint8Array) return { __bytes: true, length: value.length };
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'function' || typeof value === 'symbol') return String(value);
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return value;
  if (Array.isArray(value)) {
    const out = new Array(value.length);
    for (let i = 0; i < value.length; i++) out[i] = sanitizeForJson5(value[i], depth + 1);
    return out;
  }
  if (t === 'object') {
    const out = {};
    for (const k of Object.keys(value)) out[k] = sanitizeForJson5(value[k], depth + 1);
    return out;
  }
  return String(value);
}

function readRecords(filePath) {
  let data;
  try { data = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const out = [];
  for (const chunk of data.split('\n' + RECORD_SEPARATOR)) {
    const trimmed = chunk.replace(/^---\n/, '').trim();
    if (!trimmed) continue;
    try { out.push(JSON5.parse(trimmed)); } catch (_) {}
  }
  return out;
}

module.exports = {
  Json5Logger,
  JsonlLogger: Json5Logger,
  readRecords,
  RECORD_SEPARATOR,
};
