'use strict';

const assert = require('assert');
const {
  PROTOCOL,
  buildMasterPrompt,
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
const prompt = buildMasterPrompt({
  requestId,
  taskId: 'task-1',
  contextRound: 2,
  maxContextRounds: 3,
  task: 'Update the authentication flow.',
  allowedPaths: ['src'],
  allowDelete: false,
  files: ['src/auth.js'],
  contextText: 'No complete file context was loaded.',
  contextCatalog: '- src/auth.js [AVAILABLE, NOT LOADED]',
  targetResponseCharacters: 24000
});
assert.match(prompt, /TASK ID\ntask-1/);
assert.match(prompt, /CONTEXT ROUND\n2 of 3/);
assert.match(prompt, /"needsContext"/);
assert.match(prompt, /below 24000 characters/);

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
assert.equal(parsed.kind, 'changes');
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
assert.equal(extractResponse(noChanges, requestId).kind, 'noChanges');

const needsContext = JSON.stringify({
  protocol: PROTOCOL,
  requestId,
  needsContext: {
    paths: ['src/auth.js', './src/routes.js'],
    reason: 'The route contract is required.'
  }
});
const contextRequest = extractResponse(needsContext, requestId);
assert.equal(contextRequest.kind, 'needsContext');
assert.deepEqual(
  contextRequest.contextRequest.paths,
  ['src/auth.js', 'src/routes.js']
);
assert.equal(
  clipboardContainsResponse(needsContext, requestId),
  true
);

assert.throws(
  () => extractResponse(
    JSON.stringify({
      protocol: PROTOCOL,
      requestId,
      needsContext: {
        paths: ['../secret'],
        reason: 'Need it.'
      }
    }),
    requestId
  ),
  /Unsafe path/
);
assert.throws(
  () => extractResponse(
    JSON.stringify({
      protocol: PROTOCOL,
      requestId,
      needsContext: {
        paths: ['src/a.js', './src/a.js'],
        reason: 'Need it.'
      }
    }),
    requestId
  ),
  /duplicate path/
);
assert.throws(
  () => extractResponse(
    JSON.stringify({
      protocol: PROTOCOL,
      requestId,
      needsContext: {
        paths: [
          '1.js',
          '2.js',
          '3.js',
          '4.js',
          '5.js',
          '6.js'
        ],
        reason: 'Too many.'
      }
    }),
    requestId
  ),
  /1 to 5 paths/
);

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
