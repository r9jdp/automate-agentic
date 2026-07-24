'use strict';

const vscode = require('vscode');
const path = require('path');
const { randomUUID } = require('crypto');
const { TextDecoder } = require('util');
const {
  VERIFY_PROMPT,
  PENDING_KEY,
  LAST_PROMPT_KEY,
  getConfiguration,
  getOutput,
  log,
  wait,
  sendToGitLab
} = require('./runtime');
const {
  resolveRepositoryRoot,
  currentBranch,
  repositoryFiles,
  statusSummary
} = require('./git');
const {
  repositoryPath,
  normalizeRepositoryPath,
  parseAllowedPaths,
  pathKey
} = require('./paths');
const {
  PROTOCOL,
  buildMasterPrompt,
  extractResponse,
  clipboardContainsResponse
} = require('./prompt');
const {
  readFileState,
  validatePlan,
  previewPlan,
  applyPlan,
  undoLastApply: undoLastFileChanges
} = require('./operations');
const {
  rankContextFiles,
  buildContextCatalog,
  contextLimitReason
} = require('./context');

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
let applyingResponse = false;

async function chooseWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 0) {
    throw new Error('Open a Git repository folder first.');
  }

  if (folders.length === 1) return folders[0];

  const activeUri = vscode.window.activeTextEditor?.document.uri;
  const activeFolder = activeUri
    ? vscode.workspace.getWorkspaceFolder(activeUri)
    : undefined;
  const selected = await vscode.window.showQuickPick(
    folders.map(folder => ({
      label: folder.name,
      description: folder.uri.fsPath,
      folder,
      picked: folder === activeFolder
    })),
    {
      title: 'Duo Agent: choose the project to edit',
      ignoreFocusOut: true
    }
  );

  if (!selected) {
    throw new Error('Project selection cancelled.');
  }

  return selected.folder;
}

function openRepositoryDocumentPaths(repositoryRoot) {
  return vscode.workspace.textDocuments
    .filter(document => document.uri.scheme === 'file')
    .map(document =>
      repositoryPath(repositoryRoot, document.uri.fsPath)
    )
    .filter(value => value && value !== '.');
}

async function chooseContextPool(
  repositoryRoot,
  files,
  configuration
) {
  const activePath = vscode.window.activeTextEditor
    ? repositoryPath(
        repositoryRoot,
        vscode.window.activeTextEditor.document.uri.fsPath
      )
    : undefined;
  const allCandidates = [...new Set([
    ...files,
    ...openRepositoryDocumentPaths(repositoryRoot),
    ...(activePath && activePath !== '.' ? [activePath] : [])
  ])]
    .sort((left, right) => left.localeCompare(right));
  const candidates = allCandidates.slice(
    0,
    configuration.maxFilePickerEntries
  );

  if (candidates.length === 0) return [];

  if (allCandidates.length > candidates.length) {
    vscode.window.showInformationMessage(
      `Duo Agent is showing the first ${candidates.length} files because ` +
        'of duoAgent.maxFilePickerEntries.'
    );
  }

  if (
    candidates.length === 1 &&
    configuration.autoIncludeActiveFile &&
    candidates[0] === activePath
  ) {
    return [activePath];
  }

  while (true) {
    const selected = await vscode.window.showQuickPick(
      candidates.map(file => ({
        label: file,
        description: 'Available to load on demand',
        picked:
          configuration.autoIncludeActiveFile && file === activePath
      })),
      {
        title: 'Duo Agent: choose files Duo may inspect',
        placeHolder:
          'Selected files stay available; only the most relevant content is sent initially.',
        canPickMany: true,
        ignoreFocusOut: true
      }
    );

    if (!selected) {
      throw new Error('Context selection cancelled.');
    }

    const chosen = selected.map(item => item.label);

    if (
      configuration.autoIncludeActiveFile &&
      activePath &&
      activePath !== '.' &&
      !chosen.some(value => pathKey(value) === pathKey(activePath))
    ) {
      chosen.unshift(activePath);
    }

    const unique = [...new Set(chosen)];

    if (unique.length <= configuration.maxContextPoolFiles) {
      return unique;
    }

    await vscode.window.showWarningMessage(
      `You selected ${unique.length} files, but ` +
        `duoAgent.maxContextPoolFiles is ` +
        `${configuration.maxContextPoolFiles}. Select fewer files.`
    );
  }
}

function decodeContext(bytes, file) {
  const source =
    bytes.length >= 3 &&
    bytes[0] === 0xef &&
    bytes[1] === 0xbb &&
    bytes[2] === 0xbf
      ? bytes.subarray(3)
      : bytes;

  try {
    return UTF8_DECODER.decode(source);
  } catch {
    throw new Error(`Context file is not valid UTF-8 text: ${file}`);
  }
}

function fileContextChunk(requestId, file, state, content) {
  return (
    `FILE_CONTEXT_BEGIN ${requestId}\n` +
    `PATH: ${file}\n` +
    `SHA256: ${state.sha256}\n` +
    `SOURCE: ${state.wasDirty ? 'UNSAVED_EDITOR_BUFFER' : 'FILE'}\n` +
    `CONTENT_BEGIN ${requestId}\n${content}\n` +
    `CONTENT_END ${requestId}\n` +
    `FILE_CONTEXT_END ${requestId}`
  );
}

function joinedContext(chunks) {
  return (
    chunks.join('\n\n') ||
    'No complete file context was loaded.'
  );
}

async function readContext(
  repositoryRoot,
  files,
  configuration,
  requestId,
  createPrompt
) {
  const chunks = [];
  const snapshots = [];
  const loadedFiles = [];
  const skipped = [];
  let totalCharacters = 0;
  let prompt = createPrompt(joinedContext(chunks), loadedFiles);

  if (prompt.length > configuration.maxPromptCharacters) {
    throw new Error(
      `The task instructions and repository inventory use ` +
        `${prompt.length} characters, exceeding ` +
        `duoAgent.maxPromptCharacters before file context is added.`
    );
  }

  for (const file of files) {
    if (loadedFiles.length >= configuration.maxContextFiles) {
      skipped.push({ path: file, reason: 'file-count limit' });
      continue;
    }

    let state;

    try {
      state = await readFileState(repositoryRoot, file);
    } catch (error) {
      skipped.push({
        path: file,
        reason: error instanceof Error ? error.message : String(error)
      });
      continue;
    }

    if (!state.exists) {
      skipped.push({ path: file, reason: 'file no longer exists' });
      continue;
    }

    const content = decodeContext(state.bytes, file);
    const chunk = fileContextChunk(requestId, file, state, content);
    const projectedChunks = [...chunks, chunk];
    const projectedLoaded = [...loadedFiles, file];
    const projectedPrompt = createPrompt(
      joinedContext(projectedChunks),
      projectedLoaded
    );
    const reason = contextLimitReason({
      fileCount: loadedFiles.length,
      contentCharacters: totalCharacters,
      nextContentCharacters: content.length,
      projectedPromptCharacters: projectedPrompt.length,
      maxFiles: configuration.maxContextFiles,
      maxContextCharacters: configuration.maxContextCharacters,
      maxCharactersPerFile: configuration.maxCharactersPerFile,
      maxPromptCharacters: configuration.maxPromptCharacters
    });

    if (reason) {
      skipped.push({ path: file, reason });
      continue;
    }

    totalCharacters += content.length;
    loadedFiles.push(file);
    chunks.push(chunk);
    snapshots.push({
      path: file,
      sha256: state.sha256,
      size: state.bytes.length,
      wasDirty: state.wasDirty
    });
    prompt = projectedPrompt;
  }

  const editor = vscode.window.activeTextEditor;

  if (
    editor &&
    editor.document.uri.scheme === 'file' &&
    !editor.selection.isEmpty
  ) {
    const relativePath = repositoryPath(
      repositoryRoot,
      editor.document.uri.fsPath
    );
    const alreadyFullContext = loadedFiles.some(
      file => pathKey(file) === pathKey(relativePath ?? '')
    );

    if (relativePath && relativePath !== '.' && !alreadyFullContext) {
      const selection = editor.document.getText(editor.selection);
      const selectionChunk =
        `ACTIVE_SELECTION_BEGIN ${requestId}\n` +
          `PATH: ${relativePath}\n${selection}\n` +
          `ACTIVE_SELECTION_END ${requestId}`;
      const projectedChunks = [...chunks, selectionChunk];
      const projectedPrompt = createPrompt(
        joinedContext(projectedChunks),
        loadedFiles
      );
      const reason = contextLimitReason({
        fileCount: loadedFiles.length,
        contentCharacters: totalCharacters,
        nextContentCharacters: selection.length,
        projectedPromptCharacters: projectedPrompt.length,
        maxFiles: configuration.maxContextFiles + 1,
        maxContextCharacters: configuration.maxContextCharacters,
        maxCharactersPerFile: configuration.maxCharactersPerFile,
        maxPromptCharacters: configuration.maxPromptCharacters
      });

      if (reason) {
        skipped.push({
          path: `${relativePath} (active selection)`,
          reason
        });
      } else {
        chunks.push(selectionChunk);
        totalCharacters += selection.length;
        prompt = projectedPrompt;
      }
    }
  }

  return {
    contextText: joinedContext(chunks),
    snapshots,
    loadedFiles,
    skipped,
    totalCharacters,
    prompt
  };
}

async function ensureSameBranch(pending) {
  const branch = await currentBranch(pending.repositoryRoot);

  if ((pending.branchAtRequest ?? '') !== branch) {
    throw new Error(
      'The current Git branch changed while GitLab Duo was responding. ' +
        'Run the task again on this branch.'
    );
  }
}

async function ensureContextSnapshotsCurrent(pending) {
  for (const snapshot of pending.contextSnapshots ?? []) {
    const state = await readFileState(
      pending.repositoryRoot,
      snapshot.path
    );

    if (!state.exists || state.sha256 !== snapshot.sha256) {
      throw new Error(
        `${snapshot.path} changed while GitLab Duo was gathering ` +
          'context. Run the task again.'
      );
    }
  }
}

function includesPath(files, candidate) {
  const expected = pathKey(candidate);
  return files.some(file => pathKey(file) === expected);
}

function uniquePaths(files) {
  const seen = new Set();

  return files.filter(file => {
    const key = pathKey(file);

    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function roundPromptFactory(options) {
  const {
    pending,
    requestId,
    round,
    contextPool,
    configuration
  } = options;

  return (contextText, loadedFiles) =>
    buildMasterPrompt({
      requestId,
      taskId: pending.taskId,
      contextRound: round,
      maxContextRounds: configuration.maxContextRounds,
      task: pending.task,
      allowedPaths: pending.allowedPaths,
      allowDelete: pending.allowDelete,
      files: pending.inventory,
      contextText,
      contextCatalog: buildContextCatalog(
        contextPool,
        loadedFiles
      ),
      targetResponseCharacters:
        configuration.targetResponseCharacters
    });
}

async function stopPendingTask(context, message) {
  await context.workspaceState.update(PENDING_KEY, undefined);
  log(`Task stopped: ${message}`);
  vscode.window.showWarningMessage(message);
}

async function approveContextPoolExpansion(
  context,
  pending,
  requestedPaths,
  configuration
) {
  const outsidePool = requestedPaths.filter(
    file => !includesPath(pending.contextPool, file)
  );

  if (outsidePool.length === 0) return pending.contextPool;

  const unknown = outsidePool.filter(
    file => !includesPath(pending.inventory, file)
  );

  if (unknown.length > 0) {
    await stopPendingTask(
      context,
      `GitLab Duo requested file(s) outside the supplied repository ` +
        `inventory: ${unknown.join(', ')}. No files were changed.`
    );
    return undefined;
  }

  const expanded = uniquePaths([
    ...pending.contextPool,
    ...outsidePool
  ]);

  if (expanded.length > configuration.maxContextPoolFiles) {
    await stopPendingTask(
      context,
      `The requested context would exceed ` +
        `duoAgent.maxContextPoolFiles ` +
        `(${configuration.maxContextPoolFiles}). No files were changed.`
    );
    return undefined;
  }

  const approval = await vscode.window.showWarningMessage(
    `GitLab Duo requested access to ${outsidePool.length} additional ` +
      'file(s).',
    {
      modal: true,
      detail: outsidePool.join('\n')
    },
    'Allow Requested Files'
  );

  if (approval !== 'Allow Requested Files') {
    await stopPendingTask(
      context,
      'Additional file access was not approved. No files were changed.'
    );
    return undefined;
  }

  return expanded;
}

async function continueWithRequestedContext(
  context,
  pending,
  contextRequest,
  configuration
) {
  if (pending.round >= configuration.maxContextRounds) {
    await stopPendingTask(
      context,
      `GitLab Duo still needs more context after ` +
        `${configuration.maxContextRounds} rounds. Split the task into ` +
        'smaller changes. No files were changed.'
    );
    return;
  }

  await ensureContextSnapshotsCurrent(pending);

  const requestedPaths = contextRequest.paths.map(
    normalizeRepositoryPath
  );
  const newRequests = requestedPaths.filter(
    file => !includesPath(pending.contextFiles, file)
  );

  if (newRequests.length === 0) {
    await stopPendingTask(
      context,
      'GitLab Duo requested only files that were already loaded. ' +
        'No files were changed.'
    );
    return;
  }

  const contextPool = await approveContextPoolExpansion(
    context,
    pending,
    newRequests,
    configuration
  );

  if (!contextPool) return;

  const requestId = randomUUID();
  const round = pending.round + 1;
  const filesToLoad = uniquePaths([
    ...pending.contextFiles,
    ...newRequests
  ]);
  const promptPending = {
    ...pending,
    contextPool
  };
  const createPrompt = roundPromptFactory({
    pending: promptPending,
    requestId,
    round,
    contextPool,
    configuration
  });
  const collected = await readContext(
    pending.repositoryRoot,
    filesToLoad,
    configuration,
    requestId,
    createPrompt
  );
  const missingPrevious = pending.contextFiles.filter(
    file => !includesPath(collected.loadedFiles, file)
  );

  if (missingPrevious.length > 0) {
    await stopPendingTask(
      context,
      `Previously loaded context no longer fits the configured budget: ` +
        `${missingPrevious.join(', ')}. No files were changed.`
    );
    return;
  }

  const added = collected.loadedFiles.filter(
    file => !includesPath(pending.contextFiles, file)
  );

  if (added.length === 0) {
    const details = collected.skipped
      .filter(item => newRequests.some(
        file => pathKey(file) === pathKey(item.path)
      ))
      .map(item => `${item.path}: ${item.reason}`)
      .join('; ');
    await stopPendingTask(
      context,
      `The requested files do not fit the configured context budget` +
        `${details ? ` (${details})` : ''}. Split the task or raise the ` +
        'relevant context limit. No files were changed.'
    );
    return;
  }

  const nextPending = {
    ...pending,
    protocol: PROTOCOL,
    requestId,
    round,
    contextPool,
    contextFiles: collected.loadedFiles,
    contextSnapshots: collected.snapshots
  };

  await context.workspaceState.update(PENDING_KEY, nextPending);
  await context.workspaceState.update(
    LAST_PROMPT_KEY,
    collected.prompt
  );

  log(
    `Context round ${round}: loaded ${added.join(', ')}; ` +
      `reason: ${contextRequest.reason}`
  );
  for (const item of collected.skipped) {
    log(`Context not loaded: ${item.path} (${item.reason})`);
  }

  vscode.window.showInformationMessage(
    `GitLab Duo requested ${newRequests.length} file(s); ` +
      `loaded ${added.length}. Sending context round ${round} of ` +
      `${configuration.maxContextRounds}.`
  );

  const possibleResponse = await sendToGitLab(collected.prompt);

  if (
    typeof possibleResponse === 'string' &&
    possibleResponse.includes(requestId)
  ) {
    await vscode.env.clipboard.writeText(possibleResponse);
  }

  startResponseWatcher(
    context,
    requestId,
    configuration,
    50
  );
}

async function applyFromClipboard(context) {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before applying changes.');
  }

  if (applyingResponse) {
    throw new Error('A GitLab Duo response is already being processed.');
  }

  applyingResponse = true;

  try {
    const pending = context.workspaceState.get(PENDING_KEY);

    if (!pending) {
      throw new Error(
        'There is no pending task. Run “Duo Agent: Run Code Task” first.'
      );
    }

    await ensureSameBranch(pending);

    const configuration = getConfiguration(
      vscode.Uri.file(pending.repositoryRoot)
    );
    const response = extractResponse(
      await vscode.env.clipboard.readText(),
      pending.requestId,
      configuration.maxResponseBytes
    );

    if (response.kind === 'needsContext') {
      await continueWithRequestedContext(
        context,
        pending,
        response.contextRequest,
        configuration
      );
      return;
    }

    if (response.kind === 'noChanges') {
      log(`GitLab Duo returned no changes: ${response.reason}`);
      await context.workspaceState.update(PENDING_KEY, undefined);
      vscode.window.showWarningMessage(
        `GitLab Duo could not produce changes: ${response.reason}`
      );
      return;
    }

    const prepared = await validatePlan(
      pending.repositoryRoot,
      response.plan,
      pending,
      configuration
    );
    const approved = await previewPlan(prepared);

    if (!approved) {
      vscode.window.showInformationMessage('No files were changed.');
      return;
    }

    if (
      prepared.operations.some(operation => operation.op === 'delete')
    ) {
      const typed = await vscode.window.showInputBox({
        title: 'Confirm file deletion',
        prompt:
          'The reviewed changes delete one or more files. Type DELETE to continue.',
        ignoreFocusOut: true,
        validateInput: value =>
          value === 'DELETE' ? undefined : 'Type DELETE exactly.'
      });

      if (typed !== 'DELETE') {
        vscode.window.showInformationMessage('No files were changed.');
        return;
      }
    }

    await applyPlan(
      pending.repositoryRoot,
      response.plan,
      pending,
      context,
      configuration
    );
  } finally {
    applyingResponse = false;
  }
}

async function waitForCopiedResponse(
  context,
  requestId,
  configuration
) {
  const started = Date.now();
  const limit = configuration.clipboardWaitSeconds * 1000;

  while (Date.now() - started < limit) {
    const pending = context.workspaceState.get(PENDING_KEY);

    if (!pending || pending.requestId !== requestId) return;

    const clipboard = await vscode.env.clipboard.readText();

    if (
      clipboardContainsResponse(
        clipboard,
        requestId,
        configuration.maxResponseBytes
      )
    ) {
      if (applyingResponse) return;
      await applyFromClipboard(context);
      return;
    }

    await wait(1000);
  }

  vscode.window.showWarningMessage(
    'Duo Agent stopped waiting for the copied response. Copy the response ' +
      'and run “Duo Agent: Apply Copied Response”.'
  );
}

function startResponseWatcher(
  context,
  requestId,
  configuration,
  delayMilliseconds = 0
) {
  wait(delayMilliseconds)
    .then(() =>
      waitForCopiedResponse(context, requestId, configuration)
    )
    .catch(error => {
      const message = error instanceof Error
        ? error.message
        : String(error);
      log(`[ERROR] ${message}`);
      getOutput().show(true);
      vscode.window.showErrorMessage(`Duo Agent: ${message}`);
    });
}

function taskMayDelete(task) {
  return /\b(delete|remove|obsolete|cleanup|clean up|drop)\b/i.test(task);
}

async function chooseDeletePermission(task) {
  if (!taskMayDelete(task)) return false;

  const choice = await vscode.window.showQuickPick(
    [
      {
        label: 'Do not allow deletion',
        description: 'Duo may create and replace files only',
        value: false
      },
      {
        label: 'Allow deletion for this task',
        description: 'A second DELETE confirmation is still required',
        value: true
      }
    ],
    {
      title: 'This task may require deleting files',
      ignoreFocusOut: true
    }
  );

  if (!choice) {
    throw new Error('Deletion choice cancelled.');
  }

  return choice.value;
}

async function runTask(extensionContext) {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before running Duo Agent.');
  }

  const output = getOutput();
  output.clear();

  const folder = await chooseWorkspaceFolder();
  const repositoryRoot = await resolveRepositoryRoot(folder);
  const configuration = getConfiguration(folder.uri);
  const branchAtRequest = await currentBranch(repositoryRoot);

  const task = await vscode.window.showInputBox({
    title: 'Duo Agent: describe the code change',
    prompt: 'Describe what GitLab Duo should create or modify.',
    placeHolder:
      'Refactor trial.py and add input validation without changing its public behavior.',
    ignoreFocusOut: true,
    validateInput: value =>
      value.trim().length >= 10
        ? undefined
        : 'Use at least 10 characters.'
  });

  if (!task) {
    throw new Error('Task cancelled.');
  }

  const activeAbsolutePath =
    vscode.window.activeTextEditor?.document.uri.fsPath;
  const activeRelativePath = activeAbsolutePath
    ? repositoryPath(repositoryRoot, activeAbsolutePath)
    : undefined;
  const suggestedScope =
    activeRelativePath && activeRelativePath !== '.'
      ? activeRelativePath
      : configuration.defaultAllowedPaths.join(', ');
  const writableInput = await vscode.window.showInputBox({
    title: 'Duo Agent: files or folders that may change',
    prompt:
      'Use repository-relative paths separated by commas. The active file is suggested for safety.',
    value: suggestedScope,
    ignoreFocusOut: true
  });

  if (writableInput === undefined) {
    throw new Error('Writable scope entry cancelled.');
  }

  const allowedPaths = parseAllowedPaths(writableInput);

  if (allowedPaths.includes('.')) {
    const broadApproval = await vscode.window.showWarningMessage(
      'The writable scope includes the entire repository.',
      {
        modal: true,
        detail:
          'GitLab Duo may propose changes to any non-protected text file.'
      },
      'Allow Entire Repository'
    );

    if (broadApproval !== 'Allow Entire Repository') {
      throw new Error('Entire-repository access was not approved.');
    }
  }

  const allowDelete = await chooseDeletePermission(task);
  const allFiles = await repositoryFiles(
    repositoryRoot,
    Math.max(
      configuration.maxTreeEntries,
      configuration.maxFilePickerEntries
    )
  );
  const contextPool = await chooseContextPool(
    repositoryRoot,
    allFiles,
    configuration
  );
  const taskId = randomUUID();
  const requestId = randomUUID();
  const openPaths = openRepositoryDocumentPaths(repositoryRoot);
  const inventory = [...new Set([
    ...allFiles,
    ...openPaths
  ])]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, configuration.maxTreeEntries);
  const rankedContext = rankContextFiles({
    files: contextPool,
    activePath: activeRelativePath,
    task: task.trim(),
    openPaths,
    allowedPaths
  });
  const promptState = {
    taskId,
    task: task.trim(),
    allowedPaths,
    allowDelete,
    inventory
  };
  const createPrompt = roundPromptFactory({
    pending: promptState,
    requestId,
    round: 1,
    contextPool,
    configuration
  });
  const collected = await readContext(
    repositoryRoot,
    rankedContext,
    configuration,
    requestId,
    createPrompt
  );
  const prompt = collected.prompt;
  const pending = {
    protocol: PROTOCOL,
    taskId,
    requestId,
    round: 1,
    task: task.trim(),
    repositoryRoot,
    branchAtRequest,
    allowedPaths,
    inventory,
    contextPool,
    contextFiles: collected.loadedFiles,
    contextSnapshots: collected.snapshots,
    allowDelete,
    createdAt: new Date().toISOString()
  };

  await extensionContext.workspaceState.update(PENDING_KEY, pending);
  await extensionContext.workspaceState.update(LAST_PROMPT_KEY, prompt);

  const dirtyStatus = await statusSummary(repositoryRoot);
  log(`Created request ${requestId}`);
  log(`Current branch: ${branchAtRequest || '(detached or unborn)'}`);
  log(`Writable scope: ${allowedPaths.join(', ')}`);
  log(
    `Accessible context: ${contextPool.join(', ') || '(none)'}`
  );
  log(
    `Loaded context: ${collected.loadedFiles.join(', ') || '(none)'}`
  );
  for (const item of collected.skipped) {
    log(`Context not loaded: ${item.path} (${item.reason})`);
  }
  log(
    dirtyStatus
      ? 'Existing working changes detected and left in place.'
      : 'No existing Git working changes detected.'
  );
  log('Unsaved editor buffers are read directly; no save is required.');

  vscode.window.showInformationMessage(
    `${contextPool.length} file(s) accessible · ` +
      `${collected.loadedFiles.length} loaded · ` +
      `${prompt.length.toLocaleString()}/` +
      `${configuration.maxPromptCharacters.toLocaleString()} ` +
      'prompt characters.'
  );

  const possibleResponse = await sendToGitLab(prompt);

  if (
    typeof possibleResponse === 'string' &&
    possibleResponse.includes(requestId)
  ) {
    await vscode.env.clipboard.writeText(possibleResponse);
    await applyFromClipboard(extensionContext);
    return;
  }

  vscode.window.showInformationMessage(
    'Prompt sent to GitLab Duo. When it finishes, click Copy Snippet on ' +
      'the response. Duo Agent will open a review automatically.'
  );

  startResponseWatcher(
    extensionContext,
    requestId,
    configuration
  );
}

async function undoLastApply(context) {
  if (!vscode.workspace.isTrusted) {
    throw new Error('Trust the workspace before restoring files.');
  }

  await undoLastFileChanges(context);
}

async function copyLastPrompt(context) {
  const prompt = context.workspaceState.get(LAST_PROMPT_KEY);

  if (!prompt) {
    throw new Error('No previous generated prompt was found.');
  }

  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage('Copied the last generated prompt.');
}

async function verifyStaticSend() {
  await sendToGitLab(VERIFY_PROMPT);
  vscode.window.showInformationMessage(
    'Sent the verification prompt. Expected response: DUO_BRIDGE_OK'
  );
}

module.exports = {
  runTask,
  applyFromClipboard,
  copyLastPrompt,
  undoLastApply,
  verifyStaticSend,
  __test: {
    readContext,
    ensureContextSnapshotsCurrent,
    includesPath,
    uniquePaths,
    approveContextPoolExpansion
  }
};
