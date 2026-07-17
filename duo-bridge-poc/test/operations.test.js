'use strict';

const assert = require('assert');
const fsp = require('fs/promises');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const Module = require('module');

class Range {
  constructor(start, end) {
    this.start = start;
    this.end = end;
  }
}

class WorkspaceEdit {
  constructor() {
    this.replacements = [];
  }

  replace(uri, range, text) {
    this.replacements.push({ uri, range, text });
  }
}

const textDocuments = [];
const vscode = {
  workspace: {
    textDocuments,
    getConfiguration: () => ({ get: (_key, fallback) => fallback }),
    applyEdit: async edit => {
      for (const replacement of edit.replacements) {
        const document = textDocuments.find(item =>
          path.resolve(item.uri.fsPath).toLowerCase() ===
          path.resolve(replacement.uri.fsPath).toLowerCase()
        );
        if (!document) return false;
        document._text = replacement.text;
        document.isDirty = true;
      }
      return true;
    },
    openTextDocument: async () => ({})
  },
  window: {
    createOutputChannel: () => ({ appendLine() {}, show() {} }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => 'Apply Changes',
    showTextDocument: async () => undefined
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
      writeText: async () => undefined
    }
  },
  Uri: {
    file: fsPath => ({ scheme: 'file', fsPath })
  },
  ViewColumn: { Beside: 2 },
  WorkspaceEdit,
  Range
};

const originalLoad = Module._load;
Module._load = function patchedLoad(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  return originalLoad.call(this, request, parent, isMain);
};

const {
  sha256Buffer,
  readFileState,
  validatePlan,
  applyPlan
} = require('../src/operations');
const { currentBranch } = require('../src/git');

function git(root, ...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8'
  }).trim();
}

function createDocument(fsPath, text, dirty) {
  const document = {
    uri: { scheme: 'file', fsPath },
    _text: text,
    isDirty: dirty,
    getText() {
      return this._text;
    },
    positionAt(offset) {
      return { offset };
    },
    async save() {
      await fsp.writeFile(fsPath, this._text, 'utf8');
      this.isDirty = false;
      return true;
    }
  };
  textDocuments.push(document);
  return document;
}

function workspaceState() {
  const state = new Map();
  return {
    get: key => state.get(key),
    update: async (key, value) => {
      if (value === undefined) state.delete(key);
      else state.set(key, value);
    }
  };
}

async function createRepository(prefix) {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), prefix));
  git(root, 'init');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  return root;
}

async function testDirtyWorkingTreeOnCurrentBranch() {
  textDocuments.splice(0, textDocuments.length);
  const root = await createRepository('duo-agent-current-');
  const storage = path.join(root, '.storage');
  await fsp.mkdir(storage);
  await fsp.writeFile(path.join(root, 'trial.py'), 'print("hello")\n');
  await fsp.writeFile(path.join(root, 'unrelated.txt'), 'base\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');

  await fsp.writeFile(path.join(root, 'trial.py'), 'print("dirty")\n');
  await fsp.writeFile(path.join(root, 'unrelated.txt'), 'unrelated dirty\n');

  const before = await fsp.readFile(path.join(root, 'trial.py'));
  const requestId = '22222222-3333-4444-5555-666666666666';
  const branch = await currentBranch(root);
  const pending = {
    requestId,
    task: 'Replace trial.py safely',
    repositoryRoot: root,
    branchAtRequest: branch,
    allowedPaths: ['trial.py'],
    contextSnapshots: [
      {
        path: 'trial.py',
        sha256: sha256Buffer(before),
        size: before.length,
        wasDirty: false
      }
    ],
    allowDelete: false
  };
  const plan = {
    requestId,
    summary: 'Replace trial.py.',
    operations: [
      {
        op: 'replace',
        path: 'trial.py',
        expectedSha256: sha256Buffer(before),
        content: 'def main():\n    print("updated")\n\nmain()\n'
      }
    ]
  };
  const configuration = {
    maxOperations: 50,
    maxFileWriteBytes: 500000,
    maxTotalWriteBytes: 2000000,
    preserveExistingEol: true
  };

  const prepared = await validatePlan(root, plan, pending, configuration);
  assert.equal(prepared.operations.length, 1);

  await applyPlan(
    root,
    plan,
    pending,
    {
      storageUri: { scheme: 'file', fsPath: storage },
      workspaceState: workspaceState()
    },
    configuration
  );

  assert.equal(await currentBranch(root), branch);
  assert.equal(
    await fsp.readFile(path.join(root, 'trial.py'), 'utf8'),
    'def main():\n    print("updated")\n\nmain()\n'
  );
  assert.equal(
    await fsp.readFile(path.join(root, 'unrelated.txt'), 'utf8'),
    'unrelated dirty\n'
  );

  await fsp.rm(root, { recursive: true, force: true });
}

async function testUnsavedEditorBuffer() {
  textDocuments.splice(0, textDocuments.length);
  const root = await createRepository('duo-agent-unsaved-');
  const storage = path.join(root, '.storage');
  await fsp.mkdir(storage);
  const filePath = path.join(root, 'trial.py');
  await fsp.writeFile(filePath, 'print("saved")\n');
  git(root, 'add', '.');
  git(root, 'commit', '-m', 'initial');

  const document = createDocument(
    filePath,
    'print("unsaved user work")\n',
    true
  );
  const before = await readFileState(root, 'trial.py');
  const requestId = '33333333-4444-5555-6666-777777777777';
  const pending = {
    requestId,
    task: 'Update the unsaved editor buffer',
    repositoryRoot: root,
    branchAtRequest: await currentBranch(root),
    allowedPaths: ['trial.py'],
    contextSnapshots: [
      {
        path: 'trial.py',
        sha256: before.sha256,
        size: before.bytes.length,
        wasDirty: true
      }
    ],
    allowDelete: false
  };
  const plan = {
    requestId,
    summary: 'Update trial.py.',
    operations: [
      {
        op: 'replace',
        path: 'trial.py',
        expectedSha256: before.sha256,
        content: 'print("agent update")\n'
      }
    ]
  };
  const configuration = {
    maxOperations: 50,
    maxFileWriteBytes: 500000,
    maxTotalWriteBytes: 2000000,
    preserveExistingEol: true
  };

  await applyPlan(
    root,
    plan,
    pending,
    {
      storageUri: { scheme: 'file', fsPath: storage },
      workspaceState: workspaceState()
    },
    configuration
  );

  assert.equal(document.getText(), 'print("agent update")\n');
  assert.equal(document.isDirty, true);
  assert.equal(
    await fsp.readFile(filePath, 'utf8'),
    'print("saved")\n'
  );

  await fsp.rm(root, { recursive: true, force: true });
}

(async () => {
  await testDirtyWorkingTreeOnCurrentBranch();
  await testUnsavedEditorBuffer();
  console.log('Duo Agent file-writing tests passed.');
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
