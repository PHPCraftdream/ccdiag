'use strict';

const { pushWindowed } = require('./_window');

module.exports = {
  name: 'retry-storm',
  description: 'Detects repeated 5xx responses to the same endpoint',
  defaultEnabled: true,

  init(api) {
    const cfg = api.config;
    const windowMs = +(cfg.windowMs || 30000);
    const threshold = +(cfg.threshold || 5);
    const responses = [];

    return {
      onResponseHead(ctx) {
        if (ctx.statusCode < 500) return;
        pushWindowed(responses, {
          ts: Date.now(),
          method: ctx.request.method,
          host: ctx.request.host,
          path: ctx.request.path,
          status: ctx.statusCode,
        }, windowMs);
      },

      evaluate() {
        const groups = {};
        for (const r of responses) {
          const k = `${r.method}|${r.host}|${r.path}|${r.status}`;
          groups[k] = (groups[k] || 0) + 1;
        }
        for (const k of Object.keys(groups)) {
          if (groups[k] >= threshold) {
            const [method, host, path, status] = k.split('|');
            return {
              kind: 'retry_storm',
              reason: `${groups[k]} repeated ${status} responses for ${method} ${host}${path} in ${windowMs / 1000}s`,
              evidence: { method, host, path, status: +status, count: groups[k], window_ms: windowMs },
            };
          }
        }
        return null;
      },
    };
  },
};
