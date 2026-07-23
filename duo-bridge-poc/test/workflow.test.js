'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const Module = require('module');

let warningResult = 'Allow Requested Files';
const vscode = {
  workspace: {
    textDocuments: [],
    workspaceFolders: [],
    getConfiguration: () => ({ get: (_key, fallback) => fallback })
  },
  window: {
    activeTextEditor: undefined,
    createOutputChannel: () => ({ appendLine() {}, show() {}, clear() {} }),
    showWarningMessage: async () => warningResult,
    showInformationMessage: async () => undefined
  },
  extensions: {
    getExtension: () => undefined,
    all: []
  },
  commands: {
    getCommands: async () => [],
    executeCommand: async () => undefined
  },
  env: {
    clipboard: {
      readText: async () => '',
      writeText: async () => undefined
    }
  },
  Uri: {
    file: fsPath => ({ scheme: 'file', fsPath })
  }
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  readContext,
  ensureContextSnapshotsCurrent,
  includesPath,
  uniquePaths,
  approveContextPoolExpansion
} = require('../src/workflow').__test;
const { PENDING_KEY } = require('../src/runtime');

function workspaceState() {
  const state = new Map([[PENDING_KEY, { requestId: 'request-1' }]]);

  return {
    get: key => state.get(key),
    update: async (key, value) => {
      if (value === undefined) state.delete(key);
      else state.set(key, value);
    }
  };
}

const configuration = {
  maxContextFiles: 3,
  maxContextCharacters: 1000,
  maxCharactersPerFile: 500,
  maxPromptCharacters: 2000,
  maxContextPoolFiles: 5
};

async function run() {
  const root = await fsp.mkdtemp(
    path.join(os.tmpdir(), 'duo-agent-workflow-')
  );

  try {
    await fsp.writeFile(path.join(root, 'a.txt'), 'alpha\n', 'utf8');
    await fsp.writeFile(
      path.join(root, 'binary.bin'),
      Buffer.from([0, 1, 2])
    );

    const collected = await readContext(
      root,
      ['a.txt', 'binary.bin'],
      configuration,
      'request-1',
      contextText => `PROMPT\n${contextText}`
    );

    assert.deepEqual(collected.loadedFiles, ['a.txt']);
    assert.equal(collected.snapshots.length, 1);
    assert.equal(collected.skipped.length, 1);
    assert.match(collected.skipped[0].reason, /Binary|NUL/);

    await ensureContextSnapshotsCurrent({
      repositoryRoot: root,
      contextSnapshots: collected.snapshots
    });

    await fsp.writeFile(path.join(root, 'a.txt'), 'changed\n', 'utf8');
    await assert.rejects(
      ensureContextSnapshotsCurrent({
        repositoryRoot: root,
        contextSnapshots: collected.snapshots
      }),
      /changed while GitLab Duo/
    );

    assert.equal(includesPath(['src/a.js'], 'src/a.js'), true);
    assert.deepEqual(
      uniquePaths(['src/a.js', 'src/a.js', 'src/b.js']),
      ['src/a.js', 'src/b.js']
    );

    const context = { workspaceState: workspaceState() };
    const pending = {
      contextPool: ['src/a.js'],
      inventory: ['src/a.js', 'src/b.js']
    };
    const expanded = await approveContextPoolExpansion(
      context,
      pending,
      ['src/b.js'],
      configuration
    );
    assert.deepEqual(expanded, ['src/a.js', 'src/b.js']);

    warningResult = undefined;
    const deniedContext = { workspaceState: workspaceState() };
    assert.equal(
      await approveContextPoolExpansion(
        deniedContext,
        pending,
        ['src/b.js'],
        configuration
      ),
      undefined
    );
    assert.equal(
      deniedContext.workspaceState.get(PENDING_KEY),
      undefined
    );

    const unknownContext = { workspaceState: workspaceState() };
    assert.equal(
      await approveContextPoolExpansion(
        unknownContext,
        pending,
        ['src/unknown.js'],
        configuration
      ),
      undefined
    );
    assert.equal(
      unknownContext.workspaceState.get(PENDING_KEY),
      undefined
    );
  } finally {
    await fsp.rm(root, { recursive: true, force: true });
    Module._load = originalLoad;
  }

  console.log('Duo Agent progressive-workflow tests passed.');
}

run().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
