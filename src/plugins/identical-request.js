'use strict';

const { pushWindowed } = require('./_window');

module.exports = {
  name: 'identical-request',
  description: 'Detects repeated requests with identical body hash',
  defaultEnabled: true,

  init(api) {
    const cfg = api.config;
    const windowMs = +(cfg.windowMs || 60000);
    const threshold = +(cfg.threshold || 5);
    const requests = [];

    return {
      onRequest(ctx) {
        if (!ctx.bodyHash) return;
        pushWindowed(requests, {
          ts: Date.now(),
          hash: ctx.bodyHash,
          host: ctx.host,
          url: ctx.url,
        }, windowMs);
      },

      evaluate() {
        const groups = {};
        for (const r of requests) {
          const cur = groups[r.hash] || { count: 0, host: r.host, url: r.url };
          cur.count++;
          groups[r.hash] = cur;
        }
        for (const h of Object.keys(groups)) {
          if (groups[h].count >= threshold) {
            return {
              kind: 'identical_request_loop',
              reason: `${groups[h].count} requests with identical body hash to ${groups[h].host} in ${windowMs / 1000}s`,
              evidence: { body_hash: h, count: groups[h].count, host: groups[h].host, url: groups[h].url, window_ms: windowMs },
            };
          }
        }
        return null;
      },
    };
  },
};
