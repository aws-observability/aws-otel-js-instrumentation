'use strict';

if (process.env.NODE_PROFILE_IMPORT_TIME === '1') {
  const Module = require('module');
  const origLoad = Module._load;
  const cumulative = new Map();

  Module._load = function (request, parent, isMain) {
    const start = process.hrtime.bigint();
    const result = origLoad.apply(this, arguments);
    const elapsed = process.hrtime.bigint() - start;
    const selfUs = Number(elapsed) / 1e3;

    const prev = cumulative.get(request) || 0;
    const cumulativeUs = prev + selfUs;
    cumulative.set(request, cumulativeUs);

    if (selfUs > 0) {
      process.stdout.write(
        `import time: ${Math.round(selfUs)} | ${Math.round(cumulativeUs)} | ${request}\n`
      );
    }

    return result;
  };
}
