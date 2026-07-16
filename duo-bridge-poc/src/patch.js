'use strict';

const vscode = require('vscode');
const path = require('path');
const os = require('os');
const fs = require('fs/promises');
const {
  LAST_APPLY_KEY,
  PENDING_KEY
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
  requireNoSymlinkTraversal,
  pathKey
} = require('./paths');
const { branchSlug } = require('./prompt');

function changesFromPatch(patch) {
  const changes = [];
  const seenPaths = new Set();
  let section;

  const finishSection = () => {
    if (!section) return;

    if (!section.oldHeader || !section.newHeader) {
      throw new Error(
        `Patch section for ${section.path} lacks --- or +++ headers.`
      );
    }

    let action = 'modify';

    if (section.oldPath === null) {
      action = 'create';
    } else if (section.newPath === null) {
      action = 'delete';
    }

    changes.push({
      path: section.path,
      action
    });
  };

  for (const line of patch.split(/\r?\n/)) {
    if (line.startsWith('diff --git ')) {
      finishSection();

      const match = line.match(
        /^diff --git a\/(\S+) b\/(\S+)$/
      );

      if (!match) {
        throw new Error(
          'Quoted or whitespace-containing patch paths are not ' +
            'supported by this safety wrapper.'
        );
      }

      if (pathKey(match[1]) !== pathKey(match[2])) {
        throw new Error(
          'Renames and path changes are not supported.'
        );
      }

      const relativePath = normalizeRepositoryPath(match[1]);
      const key = pathKey(relativePath);

      if (seenPaths.has(key)) {
        throw new Error(
          `Patch modifies the same path more than once: ${relativePath}`
        );
      }

      seenPaths.add(key);
      section = {
        path: relativePath,
        oldHeader: false,
        newHeader: false,
        oldPath: undefined,
        newPath: undefined,
        inHunk: false
      };
      continue;
    }

    if (!section) {
      if (line.trim()) {
        throw new Error(
          'Patch contains text before its first diff --git section.'
        );
      }
      continue;
    }

    if (line.startsWith('@@ ')) {
      section.inHunk = true;
      continue;
    }

    if (section.inHunk) continue;

    const header = line.match(/^(---|\+\+\+) (.+)$/);
    if (!header) continue;

    const oldHeader = header[1] === '---';

    if (
      (oldHeader && section.oldHeader) ||
      (!oldHeader && section.newHeader)
    ) {
      throw new Error(
        `Patch contains duplicate file headers for ${section.path}.`
      );
    }

    let patchPath = header[2].trim().split('\t')[0];

    if (
      patchPath.startsWith('"') ||
      patchPath.endsWith('"')
    ) {
      throw new Error('Quoted patch paths are not supported.');
    }

    const expectedPrefix = oldHeader ? 'a/' : 'b/';
    let relativePath = null;

    if (patchPath !== '/dev/null') {
      if (!patchPath.startsWith(expectedPrefix)) {
        throw new Error(
          `Unexpected patch path prefix: ${patchPath}`
        );
      }

      relativePath = normalizeRepositoryPath(
        patchPath.slice(expectedPrefix.length)
      );

      if (pathKey(relativePath) !== pathKey(section.path)) {
        throw new Error(
          `Patch header path does not match diff header: ${patchPath}`
        );
      }
    }

    if (oldHeader) {
      section.oldHeader = true;
      section.oldPath = relativePath;
    } else {
      section.newHeader = true;
      section.newPath = relativePath;
    }
  }

  finishSection();

  if (changes.length === 0) {
    throw new Error('Patch contains no diff --git sections.');
  }

  return changes.sort((left, right) =>
    left.path.localeCompare(right.path)
  );
}

function changedPathsFromPatch(patch) {
  return changesFromPatch(patch).map(change => change.path);
}

function patchDeletesFile(patch) {
  return (
    /^deleted file mode /m.test(patch) ||
    /^\+\+\+ \/dev\/null$/m.test(patch)
  );
}

function validatePatchStructure(patch, pending, configuration) {
  if (patch.includes('\0')) {
    throw new Error('Patch contains a NUL byte.');
  }

  if (
    Buffer.byteLength(patch, 'utf8') >
    configuration.maxPatchBytes
  ) {
    throw new Error('Patch exceeds duoAgent.maxPatchBytes.');
  }

  const forbidden = [
    /^GIT binary patch$/m,
    /^Binary files /m,
    /^rename (from|to) /m,
    /^copy (from|to) /m,
    /^(new|deleted) file mode 120000$/m,
    /^(new|deleted) file mode 160000$/m,
    /^index [0-9a-f]+\.\.[0-9a-f]+ 160000$/m,
    /^Submodule /m,
    /^Subproject commit /m,
    /^(old|new) mode /m,
    /^diff --git "/m,
    /^(---|\+\+\+) "/m
  ];

  for (const pattern of forbidden) {
    if (pattern.test(patch)) {
      throw new Error(
        `Patch contains a forbidden operation: ${pattern}`
      );
    }
  }

  if (!pending.allowDelete && patchDeletesFile(patch)) {
    throw new Error(
      'Patch deletes a file, but deletion was not allowed for this task.'
    );
  }

  const operationCount =
    (patch.match(/^diff --git /gm) || []).length;

  if (operationCount === 0) {
    throw new Error('Patch contains no diff sections.');
  }

  if (operationCount > configuration.maxOperations) {
    throw new Error(
      `Patch changes ${operationCount} files; configured maximum ` +
        `is ${configuration.maxOperations}.`
    );
  }
}

async function validatePatch(
  repositoryRoot,
  patch,
  pending,
  configuration
) {
  validatePatchStructure(patch, pending, configuration);

  const changes = changesFromPatch(patch);
  const contextFiles = new Set(
    (pending.contextFiles ?? []).map(value => pathKey(value))
  );

  for (const change of changes) {
    if (!isPathAllowed(change.path, pending.allowedPaths)) {
      throw new Error(
        `Patch path is outside writable scope: ${change.path}`
      );
    }

    if (
      change.action !== 'create' &&
      !contextFiles.has(pathKey(change.path))
    ) {
      throw new Error(
        `Existing file was not supplied as complete context: ${change.path}`
      );
    }

    await requireNoSymlinkTraversal(
      repositoryRoot,
      change.path
    );
  }

  const changedPaths = changes.map(change => change.path);

  const temporaryPatch = path.join(
    os.tmpdir(),
    `duo-agent-check-${pending.requestId}.patch`
  );

  await fs.writeFile(temporaryPatch, patch, 'utf8');

  try {
    const result = await git(
      repositoryRoot,
      ['apply', '--check', temporaryPatch],
      { allowFailure: true }
    );

    if (result.exitCode !== 0) {
      throw new Error(
        `git apply --check failed.\n${
          result.stderr || result.stdout
        }`
      );
    }
  } finally {
    await fs.unlink(temporaryPatch).catch(() => undefined);
  }

  return changedPaths;
}

async function previewPatch(patch, changedPaths) {
  const document = await vscode.workspace.openTextDocument({
    language: 'diff',
    content: patch
  });

  await vscode.window.showTextDocument(document, {
    preview: true,
    viewColumn: vscode.ViewColumn.Beside
  });

  const approval = await vscode.window.showWarningMessage(
    `Apply ${changedPaths.length} changed file(s) on a new branch?`,
    {
      modal: true,
      detail: changedPaths.map(value => `- ${value}`).join('\n')
    },
    'Apply on New Branch'
  );

  return approval === 'Apply on New Branch';
}

async function applyPatch(
  repositoryRoot,
  patch,
  pending,
  changedPaths,
  context,
  configuration
) {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14);
  const branch =
    `duo-agent/${timestamp}-${branchSlug(pending.task)}-` +
    pending.requestId.slice(0, 8);
  const baseCommit = await requireHead(repositoryRoot);

  if (pending.baseCommit && baseCommit !== pending.baseCommit) {
    throw new Error(
      'The repository HEAD changed after this task was created. ' +
        'Run the task again with the current revision.'
    );
  }

  const originalBranch = await currentBranch(repositoryRoot);

  await requireClean(repositoryRoot, configuration);
  await git(repositoryRoot, ['switch', '-c', branch]);

  const temporaryPatch = path.join(
    os.tmpdir(),
    `duo-agent-apply-${pending.requestId}.patch`
  );

  await fs.writeFile(temporaryPatch, patch, 'utf8');

  try {
    await git(repositoryRoot, ['apply', temporaryPatch]);
  } catch (error) {
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

    throw error;
  } finally {
    await fs.unlink(temporaryPatch).catch(() => undefined);
  }

  await context.workspaceState.update(LAST_APPLY_KEY, {
    requestId: pending.requestId,
    repositoryRoot,
    branch,
    baseCommit,
    patch,
    changedPaths,
    appliedAt: new Date().toISOString()
  });
  await context.workspaceState.update(PENDING_KEY, undefined);

  vscode.window.showInformationMessage(
    `Duo Agent applied changes on branch ${branch}. ` +
      'Review git diff before committing.'
  );
}

async function undoLastApply(context) {
  const last = context.workspaceState.get(LAST_APPLY_KEY);

  if (!last) {
    throw new Error(
      'No last applied Duo Agent patch was found.'
    );
  }

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
      'The branch has new commits. Undo manually with Git.'
    );
  }

  const status = await git(last.repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ]);
  const expected = new Set(
    last.changedPaths.map(value => pathKey(value))
  );
  const unrelated = [];
  const staged = [];

  for (const line of status.stdout.split(/\r?\n/).filter(Boolean)) {
    const indexStatus = line[0];
    const workTreeStatus = line[1];
    let statusPath = line.slice(3);

    if (statusPath.includes(' -> ')) {
      statusPath = statusPath.split(' -> ').pop();
    }

    statusPath = statusPath
      .replace(/^"|"$/g, '')
      .replace(/\\/g, '/');

    if (!expected.has(pathKey(statusPath))) {
      unrelated.push(statusPath);
    }

    if (indexStatus !== ' ' && indexStatus !== '?') {
      staged.push(statusPath);
    }

    if (indexStatus === '?' && workTreeStatus !== '?') {
      staged.push(statusPath);
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

  const temporaryPatch = path.join(
    os.tmpdir(),
    `duo-agent-undo-${last.requestId}.patch`
  );

  await fs.writeFile(temporaryPatch, last.patch, 'utf8');

  try {
    const check = await git(
      last.repositoryRoot,
      ['apply', '-R', '--check', temporaryPatch],
      { allowFailure: true }
    );

    if (check.exitCode !== 0) {
      throw new Error(
        `Reverse patch check failed.\n${
          check.stderr || check.stdout
        }`
      );
    }

    const approval = await vscode.window.showWarningMessage(
      `Undo Duo Agent changes on ${last.branch}?`,
      { modal: true },
      'Undo'
    );

    if (approval !== 'Undo') {
      return;
    }

    await git(
      last.repositoryRoot,
      ['apply', '-R', temporaryPatch]
    );
  } finally {
    await fs.unlink(temporaryPatch).catch(() => undefined);
  }

  await context.workspaceState.update(LAST_APPLY_KEY, undefined);

  vscode.window.showInformationMessage(
    'Duo Agent reversed the last applied patch.'
  );
}

module.exports = {
  changesFromPatch,
  changedPathsFromPatch,
  patchDeletesFile,
  validatePatchStructure,
  validatePatch,
  previewPatch,
  applyPatch,
  undoLastApply
};
