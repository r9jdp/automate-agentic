'use strict';

const vscode = require('vscode');
const path = require('path');
const fs = require('fs/promises');
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
  requireHead,
  requireClean,
  trackedFiles
} = require('./git');
const {
  repositoryPath,
  parseAllowedPaths,
  requireNoSymlinkTraversal
} = require('./paths');
const {
  buildMasterPrompt,
  extractResponse,
  clipboardContainsResponse
} = require('./prompt');
const {
  sha256Buffer,
  validatePlan,
  previewPlan,
  applyPlan,
  undoLastApply: undoLastOperationPlan
} = require('./operations');

const UTF8_DECODER = new TextDecoder('utf-8', { fatal: true });
let applyingResponse = false;

async function chooseWorkspaceFolder() {
  const folders = vscode.workspace.workspaceFolders ?? [];

  if (folders.length === 0) {
    throw new Error(
      'Open a folder containing a Git repository first.'
    );
  }

  if (folders.length === 1) {
    return folders[0];
  }

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
      title: 'Duo Agent: choose workspace',
      ignoreFocusOut: true
    }
  );

  if (!selected) {
    throw new Error('Workspace selection cancelled.');
  }

  return selected.folder;
}

async function saveDirtyDocuments(repositoryRoot) {
  const dirty = vscode.workspace.textDocuments
    .filter(
      document =>
        document.isDirty && document.uri.scheme === 'file'
    )
    .map(document => ({
      document,
      relativePath: repositoryPath(
        repositoryRoot,
        document.uri.fsPath
      )
    }))
    .filter(
      item =>
        item.relativePath && item.relativePath !== '.'
    );

  if (dirty.length === 0) {
    return;
  }

  const approval = await vscode.window.showWarningMessage(
    'Duo Agent must save dirty files before it builds context ' +
      'or applies changes.',
    {
      modal: true,
      detail: dirty.map(item => item.relativePath).join('\n')
    },
    'Save All and Continue'
  );

  if (approval !== 'Save All and Continue') {
    throw new Error('Unsaved files cancelled the operation.');
  }

  for (const item of dirty) {
    const saved = await item.document.save();

    if (!saved) {
      throw new Error(`Could not save ${item.relativePath}`);
    }
  }
}

async function chooseContextFiles(
  repositoryRoot,
  files,
  configuration
) {
  if (files.length === 0) {
    return [];
  }

  const activePath = vscode.window.activeTextEditor
    ? repositoryPath(
        repositoryRoot,
        vscode.window.activeTextEditor.document.uri.fsPath
      )
    : undefined;
  const items = files
    .slice(0, configuration.maxFilePickerEntries)
    .map(file => ({
      label: file,
      picked: file === activePath
    }));
  const selected = await vscode.window.showQuickPick(items, {
    title: 'Duo Agent: choose complete context files',
    placeHolder:
      'Select every existing file Duo may replace or delete.',
    canPickMany: true,
    ignoreFocusOut: true
  });

  if (!selected) {
    throw new Error('Context selection cancelled.');
  }

  return selected
    .map(item => item.label)
    .slice(0, configuration.maxContextFiles);
}

function decodeUtf8(bytes, file) {
  try {
    return UTF8_DECODER.decode(bytes);
  } catch {
    throw new Error(
      `Context file is not valid UTF-8 text: ${file}`
    );
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
    await requireNoSymlinkTraversal(repositoryRoot, file);

    const absolutePath = path.join(
      repositoryRoot,
      ...file.split('/')
    );
    const stat = await fs.lstat(absolutePath);

    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(
        `Context path is not a regular file: ${file}`
      );
    }

    const bytes = await fs.readFile(absolutePath);

    if (bytes.includes(0)) {
      throw new Error(
        `Binary context file is not supported: ${file}`
      );
    }

    const content = decodeUtf8(bytes, file);

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

    const sha256 = sha256Buffer(bytes);
    totalCharacters += content.length;
    snapshots.push({
      path: file,
      sha256,
      size: bytes.length
    });
    chunks.push(
      `FILE_CONTEXT_BEGIN ${requestId}\n` +
        `PATH: ${file}\n` +
        `SHA256: ${sha256}\n` +
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

    if (relativePath && relativePath !== '.') {
      const selection = editor.document.getText(editor.selection);

      if (
        selection.length > configuration.maxCharactersPerFile
      ) {
        throw new Error(
          'Active selection exceeds duoAgent.maxCharactersPerFile.'
        );
      }

      if (
        totalCharacters + selection.length >
        configuration.maxContextCharacters
      ) {
        throw new Error(
          'Full-file context plus the active selection exceeds ' +
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

async function applyFromClipboard(context) {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      'Trust the workspace before applying Duo Agent changes.'
    );
  }

  if (applyingResponse) {
    throw new Error(
      'A Duo Agent response is already being validated or applied.'
    );
  }

  applyingResponse = true;

  try {
    const pending = context.workspaceState.get(PENDING_KEY);

    if (!pending) {
      throw new Error(
        'No pending Duo Agent request. Run ' +
          'Duo Agent: Run Reviewed Task first.'
      );
    }

    const configuration = getConfiguration(
      vscode.Uri.file(pending.repositoryRoot)
    );

    await saveDirtyDocuments(pending.repositoryRoot);
    await requireClean(
      pending.repositoryRoot,
      configuration
    );

    const currentHead = await requireHead(pending.repositoryRoot);

    if (pending.baseCommit && currentHead !== pending.baseCommit) {
      throw new Error(
        'The repository HEAD changed after this task was sent to ' +
          'GitLab Duo. Run a new task with the current revision.'
      );
    }

    const response = extractResponse(
      await vscode.env.clipboard.readText(),
      pending.requestId,
      configuration.maxResponseBytes
    );

    if (response.noChanges) {
      const document = await vscode.workspace.openTextDocument({
        language: 'json',
        content: response.body
      });

      await vscode.window.showTextDocument(document, {
        preview: true
      });
      vscode.window.showWarningMessage(
        `GitLab Duo returned no changes: ${response.reason}`
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
      throw new Error('Operation plan application cancelled.');
    }

    if (
      prepared.operations.some(operation => operation.op === 'delete')
    ) {
      const typed = await vscode.window.showInputBox({
        title: 'Confirm deletion',
        prompt:
          'The reviewed JSON plan deletes files. Type DELETE to continue.',
        ignoreFocusOut: true,
        validateInput: value =>
          value === 'DELETE'
            ? undefined
            : 'Type DELETE exactly.'
      });

      if (typed !== 'DELETE') {
        throw new Error('Deletion was not confirmed.');
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

    if (!pending || pending.requestId !== requestId) {
      return;
    }

    const clipboard = await vscode.env.clipboard.readText();

    if (
      clipboardContainsResponse(
        clipboard,
        requestId,
        configuration.maxResponseBytes
      )
    ) {
      if (applyingResponse) {
        return;
      }

      await applyFromClipboard(context);
      return;
    }

    await wait(1000);
  }

  vscode.window.showWarningMessage(
    'Duo Agent timed out waiting for the copied JSON response. ' +
      'Copy it and run “Duo Agent: Apply Pending JSON Response ' +
      'from Clipboard”.'
  );
}

async function runTask(extensionContext) {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      'Trust the workspace before running Duo Agent.'
    );
  }

  const outputChannel = getOutput();
  outputChannel.clear();
  outputChannel.show(true);

  const folder = await chooseWorkspaceFolder();
  const repositoryRoot = await resolveRepositoryRoot(folder);
  const configuration = getConfiguration(folder.uri);
  const baseCommit = await requireHead(repositoryRoot);

  await saveDirtyDocuments(repositoryRoot);
  await requireClean(repositoryRoot, configuration);

  const task = await vscode.window.showInputBox({
    title: 'Duo Agent: task',
    prompt: 'Describe what GitLab Duo should implement.',
    placeHolder:
      'Create a validator and tests. Preserve public APIs.',
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
  const suggestedPath =
    activeRelativePath && activeRelativePath !== '.'
      ? path.posix.dirname(activeRelativePath)
      : configuration.defaultAllowedPaths.join(', ');
  const writableInput = await vscode.window.showInputBox({
    title: 'Duo Agent: writable paths',
    prompt:
      'Comma-separated repository-relative paths. Use . only ' +
      'for a controlled test repository.',
    value:
      suggestedPath === '.'
        ? configuration.defaultAllowedPaths.join(', ')
        : suggestedPath,
    ignoreFocusOut: true
  });

  if (writableInput === undefined) {
    throw new Error('Writable path entry cancelled.');
  }

  const allowedPaths = parseAllowedPaths(writableInput);

  if (allowedPaths.includes('.')) {
    const broadApproval = await vscode.window.showWarningMessage(
      'The writable scope includes the entire repository. GitLab Duo ' +
        'may propose changes to any non-protected path.',
      { modal: true },
      'Allow Entire Repository'
    );

    if (broadApproval !== 'Allow Entire Repository') {
      throw new Error(
        'Entire-repository write access was not approved.'
      );
    }
  }

  const deletion = await vscode.window.showQuickPick(
    [
      {
        label: 'No',
        description: 'Reject JSON operations that delete files',
        value: false
      },
      {
        label: 'Yes',
        description:
          'Allow deletion after an additional DELETE confirmation',
        value: true
      }
    ],
    {
      title: 'Can GitLab Duo delete files for this task?',
      ignoreFocusOut: true
    }
  );

  if (!deletion) {
    throw new Error('Deletion choice cancelled.');
  }

  const allFiles = await trackedFiles(
    repositoryRoot,
    Math.max(
      configuration.maxTreeEntries,
      configuration.maxFilePickerEntries
    )
  );
  const inventory = allFiles.slice(
    0,
    configuration.maxTreeEntries
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
  const prompt = buildMasterPrompt({
    requestId,
    task: task.trim(),
    allowedPaths,
    allowDelete: deletion.value,
    files: inventory,
    contextText: collected.contextText
  });
  const pending = {
    protocol: 'duo-agent-json-v1',
    requestId,
    task: task.trim(),
    repositoryRoot,
    baseCommit,
    allowedPaths,
    contextFiles,
    contextSnapshots: collected.snapshots,
    allowDelete: deletion.value,
    createdAt: new Date().toISOString()
  };

  await extensionContext.workspaceState.update(PENDING_KEY, pending);
  await extensionContext.workspaceState.update(LAST_PROMPT_KEY, prompt);

  log(`Created JSON request ${requestId}`);
  log(`Writable paths: ${allowedPaths.join(', ')}`);
  log(
    `Context files: ${contextFiles.join(', ') || '(none)'}`
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
    'Duo Agent sent the JSON master prompt. Click Copy Snippet on ' +
      'the Duo response; the extension will detect it.'
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
    vscode.window.showErrorMessage(`Duo Agent: ${message}`);
  });
}

async function undoLastApply(context) {
  if (!vscode.workspace.isTrusted) {
    throw new Error(
      'Trust the workspace before restoring Duo Agent changes.'
    );
  }

  await undoLastOperationPlan(context);
}

async function copyLastPrompt(context) {
  const prompt = context.workspaceState.get(LAST_PROMPT_KEY);

  if (!prompt) {
    throw new Error(
      'No previous Duo Agent master prompt was found.'
    );
  }

  await vscode.env.clipboard.writeText(prompt);
  vscode.window.showInformationMessage(
    'Copied the last Duo Agent master prompt.'
  );
}

async function verifyStaticSend() {
  await sendToGitLab(VERIFY_PROMPT);
  vscode.window.showInformationMessage(
    'Sent static verification prompt. Expected: DUO_BRIDGE_OK'
  );
}

module.exports = {
  runTask,
  applyFromClipboard,
  copyLastPrompt,
  undoLastApply,
  verifyStaticSend
};
