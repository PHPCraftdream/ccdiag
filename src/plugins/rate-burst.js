'use strict';

const { pushWindowed } = require('./_window');

module.exports = {
  name: 'rate-burst',
  description: 'Detects sudden bursts of outgoing requests',
  defaultEnabled: true,

  init(api) {
    const cfg = api.config;
    const windowMs = +(cfg.windowMs || 10000);
    const threshold = +(cfg.threshold || 30);
    const requests = [];

    return {
      onRequest(ctx) {
        pushWindowed(requests, { ts: Date.now() }, windowMs);
      },

      evaluate() {
        const cutoff = Date.now() - windowMs;
        let n = 0;
        for (const r of requests) if (r.ts >= cutoff) n++;
        if (n >= threshold) {
          return {
            kind: 'rate_burst',
            reason: `${n} requests in ${windowMs / 1000}s`,
            evidence: { count: n, window_ms: windowMs },
          };
        }
        return null;
      },
    };
  },
};
