'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const { createHash } = require('crypto');
const {
  LAST_APPLY_KEY,
  PENDING_KEY,
  log
} = require('./runtime');
const {
  git,
  requireHead,
  currentBranch,
  requireClean
} = require('./git');
const {
  normalizeRepositoryPath,
  isPathAllowed,
  absoluteRepositoryPath,
  requireNoSymlinkTraversal,
  pathKey
} = require('./paths');
const { branchSlug } = require('./prompt');

const UTF8_BOM = Buffer.from([0xef, 0xbb, 0xbf]);

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

function dominantEol(buffer) {
  const source = startsWithUtf8Bom(buffer)
    ? buffer.subarray(3)
    : buffer;
  const text = source.toString('utf8');
  const crlf = (text.match(/\r\n/g) || []).length;
  const withoutCrlf = text.replace(/\r\n/g, '');
  const lf = (withoutCrlf.match(/\n/g) || []).length;

  return crlf > lf ? '\r\n' : '\n';
}

function encodeContent(content, original, preserveExistingEol) {
  let normalized = content;

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

async function readFileState(repositoryRoot, relativePath) {
  await requireNoSymlinkTraversal(repositoryRoot, relativePath);

  const absolutePath = absoluteRepositoryPath(
    repositoryRoot,
    relativePath
  );
  const stat = await lstatIfExists(absolutePath);

  if (!stat) {
    return {
      exists: false,
      absolutePath
    };
  }

  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(
      `Operation target is not a regular file: ${relativePath}`
    );
  }

  const bytes = await fs.readFile(absolutePath);

  if (bytes.includes(0)) {
    throw new Error(
      `Binary or NUL-containing files are not supported: ${relativePath}`
    );
  }

  return {
    exists: true,
    absolutePath,
    bytes,
    mode: stat.mode & 0o777,
    sha256: sha256Buffer(bytes)
  };
}

async function requireSafeParents(repositoryRoot, relativePath) {
  const segments = relativePath.split('/');
  let current = path.resolve(repositoryRoot);

  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    const stat = await lstatIfExists(current);

    if (!stat) {
      return;
    }

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
      'This pending request uses the old patch protocol. Run a new task.'
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
        `Conflicting file paths in operation plan: ` +
          `${sorted[index]} and ${sorted[index + 1]}`
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
    throw new Error('Operation plan request ID does not match pending task.');
  }

  if (plan.operations.length > configuration.maxOperations) {
    throw new Error(
      `Operation plan contains ${plan.operations.length} operations; ` +
        `configured maximum is ${configuration.maxOperations}.`
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
        `Operation plan changes the same path more than once: ${relativePath}`
      );
    }

    seen.add(key);

    if (!isPathAllowed(relativePath, pending.allowedPaths)) {
      throw new Error(
        `Operation path is outside writable scope: ${relativePath}`
      );
    }

    await requireSafeParents(repositoryRoot, relativePath);
    const before = await readFileState(repositoryRoot, relativePath);

    if (raw.op === 'create') {
      if (before.exists) {
        throw new Error(
          `create target already exists: ${relativePath}`
        );
      }

      if (raw.content.includes('\0')) {
        throw new Error(
          `create content contains a NUL character: ${relativePath}`
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
        `Existing file was not supplied as complete context: ${relativePath}`
      );
    }

    const expected = raw.expectedSha256.toLowerCase();
    const snapshotHash = String(snapshot.sha256).toLowerCase();

    if (expected !== snapshotHash) {
      throw new Error(
        `expectedSha256 does not match supplied context for ${relativePath}`
      );
    }

    if (!before.exists) {
      throw new Error(
        `${raw.op} target no longer exists: ${relativePath}`
      );
    }

    if (before.sha256 !== expected) {
      throw new Error(
        `File changed after context was collected: ${relativePath}`
      );
    }

    if (raw.op === 'delete') {
      if (!pending.allowDelete) {
        throw new Error(
          `Deletion was not allowed for this task: ${relativePath}`
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
        `replace content contains a NUL character: ${relativePath}`
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
        `replace operation makes no effective change: ${relativePath}`
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
    path.join(os.tmpdir(), 'duo-agent-json-review-')
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
        `Could not build review diff.\n${result.stderr || result.stdout}`
      );
    }

    const summary = [
      `# Duo Agent JSON operation plan`,
      `# Request: ${prepared.requestId}`,
      `# Summary: ${prepared.summary}`,
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
    .map(operation =>
      `${operation.op.toUpperCase()} ${operation.path}`
    )
    .join('\n');
  const approval = await vscode.window.showWarningMessage(
    `Apply ${prepared.operations.length} reviewed file operation(s) ` +
      'on a new branch?',
    {
      modal: true,
      detail: details
    },
    'Apply on New Branch'
  );

  return approval === 'Apply on New Branch';
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

async function writeReplacement(operation) {
  await fs.mkdir(path.dirname(operation.before.absolutePath), {
    recursive: true
  });
  await fs.writeFile(operation.before.absolutePath, operation.afterBytes);

  if (operation.before.mode !== undefined) {
    await fs.chmod(operation.before.absolutePath, operation.before.mode);
  }
}

async function applyOne(operation) {
  const target = operation.before.absolutePath;
  operation.writeStarted = false;

  if (operation.op === 'create') {
    await fs.mkdir(path.dirname(target), { recursive: true });
    const handle = await fs.open(target, 'wx');
    operation.writeStarted = true;

    try {
      await handle.writeFile(operation.afterBytes);
    } finally {
      await handle.close();
    }
  } else if (operation.op === 'replace') {
    operation.writeStarted = true;
    await writeReplacement(operation);
  } else {
    operation.writeStarted = true;
    await fs.unlink(target);
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
      throw new Error(
        `Delete verification failed: ${operation.path}`
      );
    }
    return;
  }

  if (!state.exists || state.sha256 !== operation.afterSha256) {
    throw new Error(
      `Write verification failed: ${operation.path}`
    );
  }
}

async function rollbackApplied(repositoryRoot, applied) {
  const errors = [];

  for (const operation of [...applied].reverse()) {
    try {
      const target = absoluteRepositoryPath(
        repositoryRoot,
        operation.path
      );

      if (operation.before.exists) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, operation.before.bytes);
        await fs.chmod(target, operation.before.mode);
      } else {
        await fs.unlink(target).catch(error => {
          if (!error || error.code !== 'ENOENT') throw error;
        });
        await removeEmptyParents(repositoryRoot, path.dirname(target));
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
    await fs.writeFile(
      backupPath,
      JSON.stringify(payload),
      'utf8'
    );
    return { backupPath };
  }

  return { inlineBackup: payload };
}

async function loadUndoBackup(last) {
  if (last.backupPath) {
    return JSON.parse(
      await fs.readFile(last.backupPath, 'utf8')
    );
  }

  if (last.inlineBackup) {
    return last.inlineBackup;
  }

  throw new Error(
    'The saved undo information uses an older incompatible format.'
  );
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
  const baseCommit = await requireHead(repositoryRoot);

  if (pending.baseCommit && baseCommit !== pending.baseCommit) {
    throw new Error(
      'The repository HEAD changed after this task was created. ' +
        'Run the task again with the current revision.'
    );
  }

  await requireClean(repositoryRoot, configuration);

  const originalBranch = await currentBranch(repositoryRoot);
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const branch =
    `duo-agent/${timestamp}-${branchSlug(pending.task)}-` +
    pending.requestId.slice(0, 8);

  await git(repositoryRoot, ['switch', '-c', branch]);

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
    const rollbackErrors = await rollbackApplied(
      repositoryRoot,
      applied
    );
    const status = await git(
      repositoryRoot,
      ['status', '--porcelain=v1', '--untracked-files=all'],
      { allowFailure: true }
    );

    if (!status.stdout.trim()) {
      if (originalBranch) {
        await git(
          repositoryRoot,
          ['switch', originalBranch],
          { allowFailure: true }
        );
      } else {
        await git(
          repositoryRoot,
          ['switch', '--detach', baseCommit],
          { allowFailure: true }
        );
      }

      await git(
        repositoryRoot,
        ['branch', '-D', branch],
        { allowFailure: true }
      );
    }

    const rollbackMessage = rollbackErrors.length
      ? `\nRollback errors:\n${rollbackErrors.join('\n')}`
      : '\nApplied operations were rolled back.';

    throw new Error(
      `${error instanceof Error ? error.message : String(error)}` +
        rollbackMessage
    );
  }

  const backupPayload = {
    version: 1,
    requestId: pending.requestId,
    repositoryRoot,
    branch,
    baseCommit,
    operations: applied.map(operation => ({
      path: operation.path,
      beforeExists: operation.before.exists,
      beforeContentBase64: operation.before.exists
        ? operation.before.bytes.toString('base64')
        : undefined,
      beforeMode: operation.before.mode,
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
      baseCommit,
      changedPaths: applied.map(operation => operation.path),
      appliedAt: new Date().toISOString(),
      ...backupReference
    });
    await deleteUndoBackup(previous);
    undoSaved = true;
  } catch (error) {
    log(
      `[ERROR] Changes were applied but undo metadata could not be saved: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  }

  await context.workspaceState.update(PENDING_KEY, undefined);

  const suffix = undoSaved
    ? 'The Undo Last Applied Operation Plan command is available.'
    : 'Automatic undo is unavailable; use Git to discard changes if needed.';

  vscode.window.showInformationMessage(
    `Duo Agent applied ${applied.length} operation(s) on branch ` +
      `${branch}. Review git diff before committing. ${suffix}`
  );
}

function parseStatusPaths(stdout) {
  const entries = [];

  for (const record of stdout.split('\0').filter(Boolean)) {
    if (record.length < 4) continue;

    entries.push({
      indexStatus: record[0],
      workTreeStatus: record[1],
      path: record.slice(3).replace(/\\/g, '/')
    });
  }

  return entries;
}

async function verifyUndoState(repositoryRoot, backup) {
  for (const operation of backup.operations) {
    const state = await readFileState(repositoryRoot, operation.path);

    if (!operation.afterExists) {
      if (state.exists) {
        throw new Error(
          `Deleted file was recreated after apply: ${operation.path}`
        );
      }
      continue;
    }

    if (!state.exists || state.sha256 !== operation.afterSha256) {
      throw new Error(
        `File changed after Duo Agent applied it: ${operation.path}`
      );
    }
  }
}

async function restoreBeforeState(repositoryRoot, operation) {
  const target = absoluteRepositoryPath(repositoryRoot, operation.path);

  if (!operation.beforeExists) {
    await fs.unlink(target).catch(error => {
      if (!error || error.code !== 'ENOENT') throw error;
    });
    await removeEmptyParents(repositoryRoot, path.dirname(target));
    return;
  }

  const bytes = Buffer.from(operation.beforeContentBase64, 'base64');
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes);

  if (operation.beforeMode !== undefined) {
    await fs.chmod(target, operation.beforeMode);
  }
}

async function undoLastApply(context) {
  const last = context.workspaceState.get(LAST_APPLY_KEY);

  if (!last) {
    throw new Error('No last applied Duo Agent plan was found.');
  }

  const backup = await loadUndoBackup(last);
  const branch = await currentBranch(last.repositoryRoot);

  if (branch !== last.branch) {
    throw new Error(
      `Switch to ${last.branch} before undoing the last apply.`
    );
  }

  const head = (
    await git(last.repositoryRoot, ['rev-parse', 'HEAD'])
  ).stdout.trim();

  if (head !== last.baseCommit) {
    throw new Error(
      'The generated branch has new commits. Undo manually with Git.'
    );
  }

  const status = await git(last.repositoryRoot, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all'
  ]);
  const expected = new Set(
    backup.operations.map(operation => pathKey(operation.path))
  );
  const unrelated = [];
  const staged = [];

  for (const entry of parseStatusPaths(status.stdout)) {
    if (!expected.has(pathKey(entry.path))) {
      unrelated.push(entry.path);
    }

    if (entry.indexStatus !== ' ' && entry.indexStatus !== '?') {
      staged.push(entry.path);
    }
  }

  if (unrelated.length > 0) {
    throw new Error(
      'Unrelated working-tree changes prevent automatic undo:\n' +
        unrelated.join('\n')
    );
  }

  if (staged.length > 0) {
    throw new Error(
      'Unstage these files before automatic undo:\n' +
        [...new Set(staged)].join('\n')
    );
  }

  await verifyUndoState(last.repositoryRoot, backup);

  const approval = await vscode.window.showWarningMessage(
    `Undo the last Duo Agent operation plan on ${last.branch}?`,
    { modal: true },
    'Undo'
  );

  if (approval !== 'Undo') {
    return;
  }

  const currentStates = [];

  for (const operation of backup.operations) {
    currentStates.push({
      operation,
      state: await readFileState(last.repositoryRoot, operation.path)
    });
  }

  const restored = [];

  try {
    for (const operation of [...backup.operations].reverse()) {
      await restoreBeforeState(last.repositoryRoot, operation);
      restored.push(operation.path);
    }
  } catch (error) {
    log('[ERROR] Undo failed; attempting to restore post-apply state.');

    for (const item of currentStates) {
      const target = absoluteRepositoryPath(
        last.repositoryRoot,
        item.operation.path
      );

      if (item.state.exists) {
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, item.state.bytes);
        await fs.chmod(target, item.state.mode);
      } else {
        await fs.unlink(target).catch(() => undefined);
      }
    }

    throw error;
  }

  void restored;
  await context.workspaceState.update(LAST_APPLY_KEY, undefined);
  await deleteUndoBackup(last);

  vscode.window.showInformationMessage(
    'Duo Agent restored the files to their pre-apply state.'
  );
}

module.exports = {
  sha256Buffer,
  validatePlan,
  previewPlan,
  applyPlan,
  undoLastApply
};
