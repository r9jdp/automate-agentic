'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { createHash } = require('crypto');
const { TextDecoder } = require('util');
const {
  LAST_APPLY_KEY,
  PENDING_KEY,
  log
} = require('./runtime');
const {
  git,
  currentBranch
} = require('./git');
const {
  normalizeRepositoryPath,
  isPathAllowed,
  absoluteRepositoryPath,
  requireNoSymlinkTraversal,
  pathKey
} = require('./paths');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);
const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });

function sha256Buffer(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

function startsWithUtf8Bom(buffer) {
  return (
    buffer.length >= 3 &&
    buffer[0] === UTF8_BOM[0] &&
    buffer[1] === UTF8_BOM[1] &&
    buffer[2] === UTF8_BOM[2]
  );
}

function decodeUtf8(buffer, label) {
  const source = startsWithUtf8Bom(buffer)
    ? buffer.subarray(3)
    : buffer;

  try {
    return UTF8_DECODER.decode(source);
  } catch {
    throw new Error(`File is not valid UTF-8 text: ${label}`);
  }
}

function dominantEol(buffer) {
  const text = decodeUtf8(buffer, 'replacement source');
  const crlf = (text.match(/\r\n/g) || []).length;
  const lf = (text.replace(/\r\n/g, '').match(/\n/g) || []).length;

  return crlf > lf ? '\r\n' : '\n';
}

function encodeContent(content, original, preserveExistingEol) {
  let normalized = String(content);

  if (original && preserveExistingEol) {
    normalized = normalized
      .replace(/\r\n/g, '\n')
      .replace(/\r/g, '\n');

    if (dominantEol(original) === '\r\n') {
      normalized = normalized.replace(/\n/g, '\r\n');
    }
  }

  let bytes = Buffer.from(normalized, 'utf8');

  if (
    original &&
    startsWithUtf8Bom(original) &&
    !startsWithUtf8Bom(bytes)
  ) {
    bytes = Buffer.concat([UTF8_BOM, bytes]);
  }

  return bytes;
}

function normalizedFsPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32'
    ? resolved.toLowerCase()
    : resolved;
}

function findOpenDocument(absolutePath) {
  const expected = normalizedFsPath(absolutePath);

  return vscode.workspace.textDocuments.find(document =>
    document.uri.scheme === 'file' &&
    normalizedFsPath(document.uri.fsPath) === expected
  );
}

async function lstatIfExists(absolutePath) {
  try {
    return await fs.lstat(absolutePath);
  } catch (error) {
    if (error && error.code === 'ENOENT') {
      return undefined;
    }

    throw error;
  }
}

async function diskBytesIfExists(absolutePath, stat) {
  if (!stat) return undefined;
  return fs.readFile(absolutePath);
}

function documentBytes(document, diskBytes) {
  let bytes = Buffer.from(document.getText(), 'utf8');

  if (
    diskBytes &&
    startsWithUtf8Bom(diskBytes) &&
    !startsWithUtf8Bom(bytes)
  ) {
    bytes = Buffer.concat([UTF8_BOM, bytes]);
  }

  return bytes;
}

async function readFileState(repositoryRoot, relativePath) {
  await requireNoSymlinkTraversal(repositoryRoot, relativePath);

  const absolutePath = absoluteRepositoryPath(
    repositoryRoot,
    relativePath
  );
  const stat = await lstatIfExists(absolutePath);

  if (stat && (stat.isSymbolicLink() || !stat.isFile())) {
    throw new Error(
      `File-change target is not a regular file: ${relativePath}`
    );
  }

  const diskBytes = await diskBytesIfExists(absolutePath, stat);
  const document = findOpenDocument(absolutePath);

  if (!stat && !document) {
    return {
      exists: false,
      absolutePath,
      diskExists: false,
      wasDirty: false
    };
  }

  const bytes = document
    ? documentBytes(document, diskBytes)
    : diskBytes;

  if (!bytes) {
    throw new Error(`Could not read file state: ${relativePath}`);
  }

  if (bytes.includes(0)) {
    throw new Error(
      `Binary or NUL-containing files are not supported: ${relativePath}`
    );
  }

  decodeUtf8(bytes, relativePath);

  return {
    exists: true,
    absolutePath,
    diskExists: Boolean(stat),
    bytes,
    mode: stat ? stat.mode & 0o777 : undefined,
    sha256: sha256Buffer(bytes),
    document,
    wasDirty: Boolean(document?.isDirty)
  };
}

async function requireSafeParents(repositoryRoot, relativePath) {
  const segments = relativePath.split('/');
  let current = path.resolve(repositoryRoot);

  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);

    if (!stat) return;

    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(
        `A parent path is not a regular directory: ${relativePath}`
      );
    }
  }
}

function snapshotMap(pending) {
  const snapshots = pending.contextSnapshots;

  if (!Array.isArray(snapshots)) {
    throw new Error(
      'This pending request is from an older extension version. ' +
        'Run a new task.'
    );
  }

  return new Map(
    snapshots.map(snapshot => [
      pathKey(snapshot.path),
      snapshot
    ])
  );
}

function detectPathConflicts(operations) {
  const sorted = operations
    .map(operation => operation.path)
    .sort((left, right) => left.localeCompare(right));

  for (let index = 0; index < sorted.length - 1; index += 1) {
    const current = pathKey(sorted[index]);
    const next = pathKey(sorted[index + 1]);

    if (next.startsWith(`${current}/`)) {
      throw new Error(
        `Conflicting file paths: ${sorted[index]} and ${sorted[index + 1]}`
      );
    }
  }
}

async function validatePlan(
  repositoryRoot,
  plan,
  pending,
  configuration
) {
  if (plan.requestId !== pending.requestId) {
    throw new Error('The copied response does not match the pending task.');
  }

  if (plan.operations.length > configuration.maxOperations) {
    throw new Error(
      `The response contains ${plan.operations.length} file changes; ` +
        `the configured maximum is ${configuration.maxOperations}.`
    );
  }

  const snapshots = snapshotMap(pending);
  const seen = new Set();
  const prepared = [];
  let totalWriteBytes = 0;

  for (const raw of plan.operations) {
    const relativePath = normalizeRepositoryPath(raw.path);
    const key = pathKey(relativePath);

    if (seen.has(key)) {
      throw new Error(
        `The response changes the same path more than once: ${relativePath}`
      );
    }

    seen.add(key);

    if (!isPathAllowed(relativePath, pending.allowedPaths)) {
      throw new Error(
        `File is outside the approved writable scope: ${relativePath}`
      );
    }

    await requireSafeParents(repositoryRoot, relativePath);
    const before = await readFileState(repositoryRoot, relativePath);

    if (raw.op === 'create') {
      if (before.exists) {
        throw new Error(`File already exists: ${relativePath}`);
      }

      if (raw.content.includes('\0')) {
        throw new Error(
          `New file content contains a NUL character: ${relativePath}`
        );
      }

      const afterBytes = encodeContent(raw.content, undefined, false);

      if (afterBytes.length > configuration.maxFileWriteBytes) {
        throw new Error(
          `${relativePath} exceeds duoAgent.maxFileWriteBytes.`
        );
      }

      totalWriteBytes += afterBytes.length;
      prepared.push({
        op: 'create',
        path: relativePath,
        before,
        afterBytes,
        afterSha256: sha256Buffer(afterBytes)
      });
      continue;
    }

    const snapshot = snapshots.get(key);

    if (!snapshot) {
      throw new Error(
        `Select the complete existing file as context and run again: ` +
          relativePath
      );
    }

    const expected = raw.expectedSha256.toLowerCase();
    const snapshotHash = String(snapshot.sha256).toLowerCase();

    if (expected !== snapshotHash) {
      throw new Error(
        `GitLab Duo returned the wrong file version for ${relativePath}.`
      );
    }

    if (!before.exists) {
      throw new Error(`${relativePath} no longer exists.`);
    }

    if (before.sha256 !== expected) {
      throw new Error(
        `${relativePath} changed after the prompt was sent. Run the task again.`
      );
    }

    if (raw.op === 'delete') {
      if (!pending.allowDelete) {
        throw new Error(
          `Deletion was not allowed for this task: ${relativePath}`
        );
      }

      if (before.document?.isDirty) {
        throw new Error(
          `Close or save the unsaved file before deleting it: ${relativePath}`
        );
      }

      prepared.push({
        op: 'delete',
        path: relativePath,
        before,
        afterBytes: undefined,
        afterSha256: undefined
      });
      continue;
    }

    if (raw.content.includes('\0')) {
      throw new Error(
        `Replacement content contains a NUL character: ${relativePath}`
      );
    }

    const afterBytes = encodeContent(
      raw.content,
      before.bytes,
      configuration.preserveExistingEol
    );

    if (afterBytes.length > configuration.maxFileWriteBytes) {
      throw new Error(
        `${relativePath} exceeds duoAgent.maxFileWriteBytes.`
      );
    }

    const afterSha256 = sha256Buffer(afterBytes);

    if (afterSha256 === before.sha256) {
      throw new Error(
        `The proposed replacement makes no change: ${relativePath}`
      );
    }

    totalWriteBytes += afterBytes.length;
    prepared.push({
      op: 'replace',
      path: relativePath,
      before,
      afterBytes,
      afterSha256
    });
  }

  detectPathConflicts(prepared);

  if (totalWriteBytes > configuration.maxTotalWriteBytes) {
    throw new Error(
      'Combined write size exceeds duoAgent.maxTotalWriteBytes.'
    );
  }

  return {
    requestId: plan.requestId,
    summary: plan.summary,
    operations: prepared,
    totalWriteBytes
  };
}

async function writeTreeFile(root, relativePath, bytes) {
  const target = path.join(root, ...relativePath.split('/'));
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);
}

function normalizePreviewDiff(diff) {
  return diff
    .split(/\r?\n/)
    .map(line => {
      if (line.startsWith('diff --git ')) {
        return line
          .replace(' a/before/', ' a/')
          .replace(' b/after/', ' b/');
      }

      if (line.startsWith('--- a/before/')) {
        return line.replace('--- a/before/', '--- a/');
      }

      if (line.startsWith('+++ b/after/')) {
        return line.replace('+++ b/after/', '+++ b/');
      }

      return line;
    })
    .join('\n');
}

async function buildReviewDocument(prepared) {
  const temporaryRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), 'duo-agent-review-')
  );
  const beforeRoot = path.join(temporaryRoot, 'before');
  const afterRoot = path.join(temporaryRoot, 'after');

  await fs.mkdir(beforeRoot, { recursive: true });
  await fs.mkdir(afterRoot, { recursive: true });

  try {
    for (const operation of prepared.operations) {
      if (operation.before.exists) {
        await writeTreeFile(
          beforeRoot,
          operation.path,
          operation.before.bytes
        );
      }

      if (operation.afterBytes !== undefined) {
        await writeTreeFile(
          afterRoot,
          operation.path,
          operation.afterBytes
        );
      }
    }

    const result = await git(
      temporaryRoot,
      [
        '-c',
        'core.quotePath=false',
        'diff',
        '--no-index',
        '--no-renames',
        '--text',
        '--',
        'before',
        'after'
      ],
      { allowFailure: true }
    );

    if (![0, 1].includes(result.exitCode)) {
      throw new Error(
        `Could not build the review diff.\n${result.stderr || result.stdout}`
      );
    }

    const summary = [
      '# Duo Agent proposed file changes',
      `# ${prepared.summary}`,
      ...prepared.operations.map(operation =>
        `# ${operation.op.toUpperCase()} ${operation.path}`
      ),
      ''
    ].join('\n');

    return summary + normalizePreviewDiff(result.stdout);
  } finally {
    await fs.rm(temporaryRoot, {
      recursive: true,
      force: true
    });
  }
}

async function previewPlan(prepared) {
  const review = await buildReviewDocument(prepared);
  const document = await vscode.workspace.openTextDocument({
    language: 'diff',
    content: review
  });

  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside
  });

  const details = prepared.operations
    .map(operation => `${operation.op.toUpperCase()} ${operation.path}`)
    .join('\n');
  const approval = await vscode.window.showWarningMessage(
    `Apply ${prepared.operations.length} proposed file change(s) ` +
      'to the current branch?',
    {
      modal: true,
      detail: details
    },
    'Apply Changes'
  );

  return approval === 'Apply Changes';
}

async function replaceDocument(document, bytes, saveAfter) {
  const text = decodeUtf8(bytes, document.uri.fsPath);
  const edit = new vscode.WorkspaceEdit();
  const fullRange = new vscode.Range(
    document.positionAt(0),
    document.positionAt(document.getText().length)
  );

  edit.replace(document.uri, fullRange, text);

  const applied = await vscode.workspace.applyEdit(edit);

  if (!applied) {
    throw new Error(`VS Code rejected the edit for ${document.uri.fsPath}`);
  }

  if (saveAfter) {
    const saved = await document.save();

    if (!saved) {
      throw new Error(`Could not save ${document.uri.fsPath}`);
    }
  }
}

async function writeBytes(operation, bytes, saveAfter) {
  const document = findOpenDocument(operation.before.absolutePath);

  if (document) {
    await replaceDocument(document, bytes, saveAfter);
  } else {
    await fs.mkdir(path.dirname(operation.before.absolutePath), {
      recursive: true
    });
    await fs.writeFile(operation.before.absolutePath, bytes);
  }

  if (operation.before.mode !== undefined) {
    await fs.chmod(
      operation.before.absolutePath,
      operation.before.mode
    ).catch(() => undefined);
  }
}

async function removeEmptyParents(repositoryRoot, startDirectory) {
  const root = path.resolve(repositoryRoot);
  let current = path.resolve(startDirectory);

  while (current !== root && current.startsWith(`${root}${path.sep}`)) {
    try {
      await fs.rmdir(current);
    } catch {
      break;
    }

    current = path.dirname(current);
  }
}

async function applyOne(operation) {
  operation.writeStarted = false;

  if (operation.op === 'create') {
    await fs.mkdir(path.dirname(operation.before.absolutePath), {
      recursive: true
    });
    const handle = await fs.open(operation.before.absolutePath, 'wx');
    operation.writeStarted = true;

    try {
      await handle.writeFile(operation.afterBytes);
    } finally {
      await handle.close();
    }
  } else if (operation.op === 'replace') {
    operation.writeStarted = true;
    await writeBytes(
      operation,
      operation.afterBytes,
      !operation.before.wasDirty
    );
  } else {
    operation.writeStarted = true;
    await fs.unlink(operation.before.absolutePath);
  }
}

async function assertOperationStillCurrent(repositoryRoot, operation) {
  const state = await readFileState(repositoryRoot, operation.path);

  if (!operation.before.exists) {
    if (state.exists) {
      throw new Error(
        `Target appeared after review: ${operation.path}`
      );
    }
    return;
  }

  if (!state.exists || state.sha256 !== operation.before.sha256) {
    throw new Error(
      `Target changed after review: ${operation.path}`
    );
  }
}

async function verifyOperationResult(repositoryRoot, operation) {
  const state = await readFileState(repositoryRoot, operation.path);

  if (operation.op === 'delete') {
    if (state.exists) {
      throw new Error(`Delete verification failed: ${operation.path}`);
    }
    return;
  }

  if (!state.exists || state.sha256 !== operation.afterSha256) {
    throw new Error(`Write verification failed: ${operation.path}`);
  }
}

async function rollbackApplied(repositoryRoot, applied) {
  const errors = [];

  for (const operation of [...applied].reverse()) {
    try {
      if (operation.before.exists) {
        await writeBytes(
          operation,
          operation.before.bytes,
          !operation.before.wasDirty
        );
      } else {
        await fs.unlink(operation.before.absolutePath).catch(error => {
          if (!error || error.code !== 'ENOENT') throw error;
        });
        await removeEmptyParents(
          repositoryRoot,
          path.dirname(operation.before.absolutePath)
        );
      }
    } catch (error) {
      errors.push(
        `${operation.path}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  return errors;
}

async function saveUndoBackup(context, payload) {
  const storage = context.storageUri || context.globalStorageUri;

  if (storage && storage.scheme === 'file') {
    const directory = path.join(storage.fsPath, 'undo');
    const backupPath = path.join(
      directory,
      `${payload.requestId}.json`
    );
    await fs.mkdir(directory, { recursive: true });
    await fs.writeFile(backupPath, JSON.stringify(payload), 'utf8');
    return { backupPath };
  }

  return { inlineBackup: payload };
}

async function loadUndoBackup(last) {
  if (last.backupPath) {
    return JSON.parse(await fs.readFile(last.backupPath, 'utf8'));
  }

  if (last.inlineBackup) return last.inlineBackup;

  throw new Error('No compatible undo information was found.');
}

async function deleteUndoBackup(last) {
  if (last?.backupPath) {
    await fs.unlink(last.backupPath).catch(() => undefined);
  }
}

async function applyPlan(
  repositoryRoot,
  plan,
  pending,
  context,
  configuration
) {
  const prepared = await validatePlan(
    repositoryRoot,
    plan,
    pending,
    configuration
  );
  const branch = await currentBranch(repositoryRoot);

  if ((pending.branchAtRequest ?? '') !== branch) {
    throw new Error(
      'The current Git branch changed while GitLab Duo was responding. ' +
        'Run the task again on this branch.'
    );
  }

  const applied = [];

  try {
    for (const operation of prepared.operations) {
      await assertOperationStillCurrent(repositoryRoot, operation);

      try {
        await applyOne(operation);
        applied.push(operation);
        await verifyOperationResult(repositoryRoot, operation);
      } catch (error) {
        if (operation.writeStarted && !applied.includes(operation)) {
          applied.push(operation);
        }
        throw error;
      }
    }
  } catch (error) {
    const rollbackErrors = await rollbackApplied(repositoryRoot, applied);
    const rollbackMessage = rollbackErrors.length
      ? `\nRollback errors:\n${rollbackErrors.join('\n')}`
      : '\nApplied file changes were rolled back.';

    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
        rollbackMessage
    );
  }

  const backupPayload = {
    version: 2,
    requestId: pending.requestId,
    repositoryRoot,
    branch,
    operations: applied.map(operation => ({
      path: operation.path,
      beforeExists: operation.before.exists,
      beforeContentBase64: operation.before.exists
        ? operation.before.bytes.toString('base64')
        : undefined,
      beforeMode: operation.before.mode,
      beforeWasDirty: operation.before.wasDirty,
      afterExists: operation.op !== 'delete',
      afterSha256: operation.afterSha256
    }))
  };
  const previous = context.workspaceState.get(LAST_APPLY_KEY);
  let undoSaved = false;

  try {
    const backupReference = await saveUndoBackup(
      context,
      backupPayload
    );

    await context.workspaceState.update(LAST_APPLY_KEY, {
      requestId: pending.requestId,
      repositoryRoot,
      branch,
      changedPaths: applied.map(operation => operation.path),
      appliedAt: new Date().toISOString(),
      ...backupReference
    });
    await deleteUndoBackup(previous);
    undoSaved = true;
  } catch (error) {
    log(
      `[ERROR] Changes were applied but undo data could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  await context.workspaceState.update(PENDING_KEY, undefined);

  const branchLabel = branch || 'the current checkout';
  const suffix = undoSaved
    ? 'You can use “Duo Agent: Undo Last Changes”.'
    : 'Use Git or editor undo if you need to revert them.';

  vscode.window.showInformationMessage(
    `Applied ${applied.length} file change(s) on ${branchLabel}. ` +
      `Unrelated working changes were left untouched. ${suffix}`
  );
}

async function verifyUndoState(repositoryRoot, backup) {
  for (const operation of backup.operations) {
    const relativePath = normalizeRepositoryPath(operation.path);
    const state = await readFileState(repositoryRoot, relativePath);

    if (!operation.afterExists) {
      if (state.exists) {
        throw new Error(
          `Cannot undo because this path now exists: ${relativePath}`
        );
      }
      continue;
    }

    if (!state.exists || state.sha256 !== operation.afterSha256) {
      throw new Error(
        `Cannot undo because this file changed again: ${relativePath}`
      );
    }
  }
}

async function restoreBackupOperation(repositoryRoot, operation) {
  const relativePath = normalizeRepositoryPath(operation.path);
  const absolutePath = absoluteRepositoryPath(repositoryRoot, relativePath);

  if (!operation.beforeExists) {
    await fs.unlink(absolutePath).catch(error => {
      if (!error || error.code !== 'ENOENT') throw error;
    });
    await removeEmptyParents(repositoryRoot, path.dirname(absolutePath));
    return;
  }

  const bytes = Buffer.from(operation.beforeContentBase64, 'base64');
  const before = {
    absolutePath,
    mode: operation.beforeMode,
    wasDirty: Boolean(operation.beforeWasDirty)
  };

  await writeBytes(
    { before },
    bytes,
    !before.wasDirty
  );
}

async function undoLastApply(context) {
  const last = context.workspaceState.get(LAST_APPLY_KEY);

  if (!last) {
    throw new Error('There are no Duo Agent changes to undo.');
  }

  const backup = await loadUndoBackup(last);
  const branch = await currentBranch(last.repositoryRoot);

  if ((backup.branch ?? '') !== branch) {
    throw new Error(
      `Switch back to ${backup.branch || 'the original checkout'} ` +
        'before undoing these changes.'
    );
  }

  await verifyUndoState(last.repositoryRoot, backup);

  const approval = await vscode.window.showWarningMessage(
    `Undo ${backup.operations.length} Duo Agent file change(s) ` +
      'on the current branch?',
    { modal: true },
    'Undo Changes'
  );

  if (approval !== 'Undo Changes') return;

  const restored = [];

  try {
    for (const operation of [...backup.operations].reverse()) {
      await restoreBackupOperation(last.repositoryRoot, operation);
      restored.push(operation.path);
    }
  } catch (error) {
    throw new Error(
      `Undo stopped after restoring ${restored.length} file(s): ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  await deleteUndoBackup(last);
  await context.workspaceState.update(LAST_APPLY_KEY, undefined);

  vscode.window.showInformationMessage(
    'Duo Agent restored the files to their previous contents.'
  );
}

module.exports = {
  sha256Buffer,
  readFileState,
  validatePlan,
  previewPlan,
  applyPlan,
  undoLastApply
};
