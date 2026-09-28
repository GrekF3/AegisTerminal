'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { compactJsonl } = require('./portfolio-analyzer.cjs');

test('analyzer compacts raw simulation journals instead of growing forever', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'lbank-analyzer-')), file = path.join(directory, 'events.jsonl');
  try {
    fs.writeFileSync(file, Array.from({ length: 20 }, (_, index) => JSON.stringify({ index })).join('\n') + '\n');
    compactJsonl(file, 5);
    const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
    assert.deepEqual(rows.map(row => row.index), [15, 16, 17, 18, 19]);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});
