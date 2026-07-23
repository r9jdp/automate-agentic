'use strict';

const assert = require('assert');
const {
  taskMentionsPath,
  rankContextFiles,
  buildContextCatalog,
  contextLimitReason
} = require('../src/context');

assert.equal(
  taskMentionsPath('Update src/auth/login.js', 'src/auth/login.js'),
  true
);
assert.equal(
  taskMentionsPath('Update login.js', 'src/auth/login.js'),
  true
);
assert.equal(
  taskMentionsPath('Update registration', 'src/auth/login.js'),
  false
);

assert.deepEqual(
  rankContextFiles({
    files: [
      'docs/readme.md',
      'src/writable.js',
      'src/mentioned.js',
      'src/open.js',
      'src/active.js'
    ],
    activePath: 'src/active.js',
    task: 'Please change mentioned.js',
    openPaths: ['src/open.js'],
    allowedPaths: ['src/writable.js']
  }),
  [
    'src/active.js',
    'src/mentioned.js',
    'src/open.js',
    'src/writable.js',
    'docs/readme.md'
  ]
);

assert.match(
  buildContextCatalog(
    ['src/a.js', 'src/b.js'],
    ['src/a.js']
  ),
  /src\/a\.js \[FULL CONTENT LOADED\]/
);
assert.match(
  buildContextCatalog(
    ['src/a.js', 'src/b.js'],
    ['src/a.js']
  ),
  /src\/b\.js \[AVAILABLE, NOT LOADED\]/
);

const limits = {
  fileCount: 1,
  contentCharacters: 100,
  nextContentCharacters: 20,
  projectedPromptCharacters: 500,
  maxFiles: 2,
  maxContextCharacters: 200,
  maxCharactersPerFile: 50,
  maxPromptCharacters: 600
};

assert.equal(contextLimitReason(limits), undefined);
assert.equal(
  contextLimitReason({
    ...limits,
    nextContentCharacters: 51
  }),
  'per-file limit'
);
assert.equal(
  contextLimitReason({
    ...limits,
    fileCount: 2
  }),
  'file-count limit'
);
assert.equal(
  contextLimitReason({
    ...limits,
    contentCharacters: 190
  }),
  'context-character limit'
);
assert.equal(
  contextLimitReason({
    ...limits,
    projectedPromptCharacters: 601
  }),
  'prompt-character limit'
);

console.log('Duo Agent context-selection tests passed.');
