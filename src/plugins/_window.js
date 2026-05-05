'use strict';

function pushWindowed(arr, item, windowMs) {
  arr.push(item);
  const cutoff = item.ts - windowMs;
  while (arr.length && arr[0].ts < cutoff) arr.shift();
}

module.exports = { pushWindowed };
