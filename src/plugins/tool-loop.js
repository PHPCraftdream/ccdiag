'use strict';

const { pushWindowed } = require('./_window');

module.exports = {
  name: 'tool-loop',
  description: 'Detects repeated identical tool_use calls in SSE streams',
  defaultEnabled: true,

  init(api) {
    const cfg = api.config;
    const windowMs = +(cfg.windowMs || 300000);
    const threshold = +(cfg.threshold || 3);
    const toolUses = [];
    const blocks = new Map();

    return {
      onSseEvent(ctx) {
        const obj = ctx.data;
        if (!obj || !obj.type) return;

        if (obj.type === 'content_block_start'
            && obj.content_block && obj.content_block.type === 'tool_use') {
          blocks.set(obj.index, {
            name: obj.content_block.name,
            id: obj.content_block.id,
            inputChunks: [],
          });
        } else if (obj.type === 'content_block_delta'
            && obj.delta && obj.delta.type === 'input_json_delta') {
          const block = blocks.get(obj.index);
          if (block) block.inputChunks.push(obj.delta.partial_json);
        } else if (obj.type === 'content_block_stop') {
          const block = blocks.get(obj.index);
          if (block) {
            const inputStr = block.inputChunks.join('');
            const inputHash = inputStr
              ? require('crypto').createHash('sha256').update(inputStr).digest('hex').slice(0, 32)
              : '';
            pushWindowed(toolUses, {
              ts: Date.now(),
              key: `${block.name}|${inputHash}`,
              name: block.name,
            }, windowMs);

            api.bus.event('anthropic.tool_use', {
              name: block.name,
              id: block.id,
              input_hash: inputHash ? `sha256:${inputHash}` : undefined,
            });

            blocks.delete(obj.index);
          }
        }
      },

      evaluate() {
        const groups = {};
        for (const t of toolUses) {
          groups[t.key] = (groups[t.key] || 0) + 1;
        }
        for (const k of Object.keys(groups)) {
          if (groups[k] >= threshold) {
            const [name, hash] = k.split('|');
            return {
              kind: 'tool_call_loop',
              reason: `${groups[k]} identical tool_use calls to ${name} in ${windowMs / 1000}s`,
              evidence: { tool: name, input_hash: hash, count: groups[k], window_ms: windowMs },
            };
          }
        }
        return null;
      },
    };
  },
};
