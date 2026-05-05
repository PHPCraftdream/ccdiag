'use strict';

const path = require('path');
const { JsonlLogger } = require('./logger');
const { makeScrubber } = require('./redact');

class LogBus {
  constructor(sessionDir, meta = {}, options = {}) {
    this.dir = sessionDir;
    this.meta = meta;
    const scrub = options.scrub || makeScrubber(process.env);
    const opts = { scrub, redact: options.redact !== false, disabled: !!options.disabled };
    this.events   = new JsonlLogger(path.join(sessionDir, 'events.json5l'),   meta, opts);
    this.requests = new JsonlLogger(path.join(sessionDir, 'requests.json5l'), meta, opts);
    this.signals  = new JsonlLogger(path.join(sessionDir, 'signals.json5l'),  meta, opts);
    this.files    = new JsonlLogger(path.join(sessionDir, 'files.json5l'),    meta, opts);
  }

  event(name, data) {
    this.events.log(name, data);
  }

  request(rec) {
    const phase = rec && rec.phase ? rec.phase : 'unknown';
    this.requests.log(`req.${phase}`, rec);
  }

  signal(rec) {
    const kind = rec && rec.kind ? rec.kind : 'signal';
    this.signals.log(kind, rec);
  }

  file(rec) {
    const op = rec && rec.op ? rec.op : 'read';
    this.files.log(`fs.${op}`, rec);
  }
}

function paths(sessionDir) {
  return {
    events:   path.join(sessionDir, 'events.json5l'),
    requests: path.join(sessionDir, 'requests.json5l'),
    signals:  path.join(sessionDir, 'signals.json5l'),
    files:    path.join(sessionDir, 'files.json5l'),
    meta:     path.join(sessionDir, 'meta.json'),
    summary:  path.join(sessionDir, 'summary.json'),
  };
}

module.exports = { LogBus, paths };
