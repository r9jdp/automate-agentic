'use strict';

const assert = require('assert');
const {
  PROTOCOL,
  extractResponse,
  clipboardContainsResponse
} = require('../src/prompt');
const {
  normalizeRepositoryPath,
  parseAllowedPaths,
  isPathAllowed
} = require('../src/paths');

const requestId = '11111111-2222-3333-4444-555555555555';
const hash = 'a'.repeat(64);
const response = JSON.stringify({
  protocol: PROTOCOL,
  requestId,
  summary: 'Create and replace text files.',
  operations: [
    {
      op: 'create',
      path: 'src/new.js',
      content: 'module.exports = 1;\n'
    },
    {
      op: 'replace',
      path: 'src/old.js',
      expectedSha256: hash,
      content: 'module.exports = 2;\n'
    },
    {
      op: 'delete',
      path: 'src/remove.js',
      expectedSha256: hash
    }
  ]
});

const parsed = extractResponse(response, requestId);
assert.equal(parsed.noChanges, false);
assert.equal(parsed.plan.operations.length, 3);
assert.equal(parsed.plan.operations[1].expectedSha256, hash);
assert.equal(clipboardContainsResponse(response, requestId), true);
assert.equal(
  clipboardContainsResponse(response, 'different-request'),
  false
);

const fenced = `\`\`\`json\n${response}\n\`\`\``;
assert.equal(extractResponse(fenced, requestId).noChanges, false);

const noChanges = JSON.stringify({
  protocol: PROTOCOL,
  requestId,
  noChanges: true,
  reason: 'A required interface was not supplied.'
});
assert.equal(extractResponse(noChanges, requestId).noChanges, true);

assert.throws(
  () => extractResponse('{"protocol":"wrong"}', requestId),
  /Unsupported response protocol/
);
assert.throws(
  () => extractResponse(response, 'wrong-request'),
  /different Duo Agent request/
);
assert.throws(
  () => extractResponse(
    JSON.stringify({
      protocol: PROTOCOL,
      requestId,
      summary: 'Bad operation',
      operations: [{ op: 'patch', path: 'x' }]
    }),
    requestId
  ),
  /unsupported op/
);
assert.throws(
  () => extractResponse(
    JSON.stringify({
      protocol: PROTOCOL,
      requestId,
      summary: 'Extra key',
      operations: [
        { op: 'create', path: 'x', content: '', extra: true }
      ]
    }),
    requestId
  ),
  /unsupported field/
);

assert.equal(normalizeRepositoryPath('./src/file.js'), 'src/file.js');
assert.deepEqual(parseAllowedPaths('src, tests'), ['src', 'tests']);
assert.equal(isPathAllowed('src/a.js', ['src']), true);
assert.equal(isPathAllowed('other/a.js', ['src']), false);
assert.throws(() => normalizeRepositoryPath('../secret'), /Unsafe path/);
assert.throws(() => normalizeRepositoryPath('.git/config'), /Unsafe path/);

console.log('Duo Agent JSON protocol tests passed.');
