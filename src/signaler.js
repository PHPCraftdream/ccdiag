'use strict';

class Signaler {
  constructor(bus, options = {}) {
    this.bus = bus;
    this.fired = new Map();
    this.printToStderr = options.printToStderr !== false;
  }

  observe(findings) {
    if (!findings || !findings.length) return;
    for (const f of findings) {
      if (this.fired.has(f.kind)) continue;
      this.fired.set(f.kind, Date.now());
      this.bus.signal({
        kind: f.kind,
        reason: f.reason,
        evidence: f.evidence,
        suggested_action: f.suggestedAction,
        host: f.host,
      });
      if (this.printToStderr) this.printBanner(f);
    }
  }

  printBanner(f) {
    const sep = '─'.repeat(72);
    const lines = [
      '',
      sep,
      `[ccdiag] SIGNAL: ${f.kind}`,
      `         ${f.reason}`,
      `         evidence: ${safeJson(f.evidence)}`,
      `         (logged to signals.json5l, no action taken)`,
      sep,
      '',
    ].join('\n');
    try { process.stderr.write(lines); } catch (_) {}
  }
}

function safeJson(o) {
  try { return JSON.stringify(o); } catch (_) { return String(o); }
}

module.exports = { Signaler };
