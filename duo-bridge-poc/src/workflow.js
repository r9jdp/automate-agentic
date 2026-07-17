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
  parseAllowedPaths,
  pathKey
} = require('./paths');
const {
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

async function chooseContextFiles(
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
  const candidates = [...new Set([
    ...files,
    ...openRepositoryDocumentPaths(repositoryRoot),
    ...(activePath && activePath !== '.' ? [activePath] : [])
  ])]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, configuration.maxFilePickerEntries);

  if (candidates.length === 0) return [];

  if (
    candidates.length === 1 &&
    configuration.autoIncludeActiveFile &&
    candidates[0] === activePath
  ) {
    return [activePath];
  }

  const selected = await vscode.window.showQuickPick(
    candidates.map(file => ({
      label: file,
      picked:
        configuration.autoIncludeActiveFile && file === activePath
    })),
    {
      title: 'Duo Agent: choose files GitLab Duo should read',
      placeHolder:
        'The active file is preselected. Add any existing file Duo may edit or need for context.',
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

  return [...new Set(chosen)].slice(0, configuration.maxContextFiles);
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

async function readContext(
  repositoryRoot,
  files,
  configuration,
  requestId
) {
  const chunks = [];
  const snapshots = [];
  let totalCharacters = 0;

  for (const file of files) {
    const state = await readFileState(repositoryRoot, file);

    if (!state.exists) {
      throw new Error(`Context file no longer exists: ${file}`);
    }

    const content = decodeContext(state.bytes, file);

    if (content.length > configuration.maxCharactersPerFile) {
      throw new Error(
        `${file} exceeds duoAgent.maxCharactersPerFile.`
      );
    }

    if (
      totalCharacters + content.length >
      configuration.maxContextCharacters
    ) {
      throw new Error(
        'Selected context exceeds duoAgent.maxContextCharacters.'
      );
    }

    totalCharacters += content.length;
    snapshots.push({
      path: file,
      sha256: state.sha256,
      size: state.bytes.length,
      wasDirty: state.wasDirty
    });
    chunks.push(
      `FILE_CONTEXT_BEGIN ${requestId}\n` +
        `PATH: ${file}\n` +
        `SHA256: ${state.sha256}\n` +
        `SOURCE: ${state.wasDirty ? 'UNSAVED_EDITOR_BUFFER' : 'FILE'}\n` +
        `CONTENT_BEGIN ${requestId}\n${content}\n` +
        `CONTENT_END ${requestId}\n` +
        `FILE_CONTEXT_END ${requestId}`
    );
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
    const alreadyFullContext = files.some(
      file => pathKey(file) === pathKey(relativePath ?? '')
    );

    if (relativePath && relativePath !== '.' && !alreadyFullContext) {
      const selection = editor.document.getText(editor.selection);

      if (selection.length > configuration.maxCharactersPerFile) {
        throw new Error(
          'Active selection exceeds duoAgent.maxCharactersPerFile.'
        );
      }

      if (
        totalCharacters + selection.length >
        configuration.maxContextCharacters
      ) {
        throw new Error(
          'Selected files plus the active selection exceed ' +
            'duoAgent.maxContextCharacters.'
        );
      }

      chunks.push(
        `ACTIVE_SELECTION_BEGIN ${requestId}\n` +
          `PATH: ${relativePath}\n${selection}\n` +
          `ACTIVE_SELECTION_END ${requestId}`
      );
    }
  }

  return {
    contextText:
      chunks.join('\n\n') ||
      'No complete file context was selected.',
    snapshots
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

    if (response.noChanges) {
      log(`GitLab Duo returned no changes: ${response.reason}`);
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
  const contextFiles = await chooseContextFiles(
    repositoryRoot,
    allFiles,
    configuration
  );
  const requestId = randomUUID();
  const collected = await readContext(
    repositoryRoot,
    contextFiles,
    configuration,
    requestId
  );
  const inventory = [...new Set([
    ...allFiles,
    ...openRepositoryDocumentPaths(repositoryRoot)
  ])]
    .sort((left, right) => left.localeCompare(right))
    .slice(0, configuration.maxTreeEntries);
  const prompt = buildMasterPrompt({
    requestId,
    task: task.trim(),
    allowedPaths,
    allowDelete,
    files: inventory,
    contextText: collected.contextText
  });
  const pending = {
    protocol: 'duo-agent-json-v1',
    requestId,
    task: task.trim(),
    repositoryRoot,
    branchAtRequest,
    allowedPaths,
    contextFiles,
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
  log(`Context files: ${contextFiles.join(', ') || '(none)'}`);
  log(
    dirtyStatus
      ? 'Existing working changes detected and left in place.'
      : 'No existing Git working changes detected.'
  );
  log('Unsaved editor buffers are read directly; no save is required.');

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

  waitForCopiedResponse(
    extensionContext,
    requestId,
    configuration
  ).catch(error => {
    const message = error instanceof Error
      ? error.message
      : String(error);
    log(`[ERROR] ${message}`);
    getOutput().show(true);
    vscode.window.showErrorMessage(`Duo Agent: ${message}`);
  });
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
  verifyStaticSend
};
