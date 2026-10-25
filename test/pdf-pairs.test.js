const { test } = require('node:test');
const assert = require('node:assert');
const { Doc } = require('../pdf.js');

test('pairs wraps long labels inside the label column', () => {
  const doc = new Doc();
  const labelWidth = 220;
  const label = 'What happened, in sequence — what was said, what was done, and why';
  const start = doc.y;
  doc.pairs([[label, 'Short answer'], ['Next', 'No']], { labelWidth });
  const labelLines = doc.wrap(label, labelWidth - 10, 9);
  assert.ok(labelLines.length > 1, 'label should need more than one line');
  for (const l of labelLines) assert.ok(doc.textWidth(l, 9) <= labelWidth - 10);
  // The row is as tall as its label, so the next row starts below it.
  const used = start - doc.y;
  assert.ok(used >= (labelLines.length + 1) * 10 * 1.35, `row height ${used} too short`);
});
