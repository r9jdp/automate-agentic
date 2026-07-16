'use strict';

const vscode = require('vscode');

const GITLAB_EXTENSION_ID = 'GitLab.gitlab-workflow';
const GITLAB_SEND_COMMAND = 'gl.showAndSendDuoQuickChatWithContext';
const GITLAB_OPEN_COMMANDS = [
  'gl.openQuickChat',
  'gl.openQuickChatWithShortcut',
  'gl.openChat'
];

const VERIFY_PROMPT =
  'Reply with exactly this text and nothing else: DUO_BRIDGE_OK';
const PENDING_KEY = 'duoAgent.pendingRequest';
const LAST_PROMPT_KEY = 'duoAgent.lastPrompt';
const LAST_APPLY_KEY = 'duoAgent.lastApply';

let output;

function getOutput() {
  if (!output) {
    output = vscode.window.createOutputChannel('Duo Agent');
  }

  return output;
}

function log(message = '') {
  getOutput().appendLine(message);
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function wait(milliseconds) {
  return new Promise(resolve => setTimeout(resolve, milliseconds));
}

function getConfiguration(resource) {
  const configuration = vscode.workspace.getConfiguration(
    'duoAgent',
    resource
  );

  return {
    requireCleanWorkingTree: configuration.get(
      'requireCleanWorkingTree',
      true
    ),
    defaultAllowedPaths: configuration.get(
      'defaultAllowedPaths',
      ['.']
    ),
    maxContextFiles: configuration.get('maxContextFiles', 12),
    maxContextCharacters: configuration.get(
      'maxContextCharacters',
      90000
    ),
    maxCharactersPerFile: configuration.get(
      'maxCharactersPerFile',
      24000
    ),
    maxTreeEntries: configuration.get('maxTreeEntries', 500),
    maxFilePickerEntries: configuration.get(
      'maxFilePickerEntries',
      800
    ),
    maxPatchBytes: configuration.get('maxPatchBytes', 1000000),
    maxOperations: configuration.get('maxOperations', 50),
    clipboardWaitSeconds: configuration.get(
      'clipboardWaitSeconds',
      600
    )
  };
}

async function activateGitLabExtension() {
  const direct = vscode.extensions.getExtension(GITLAB_EXTENSION_ID);
  const extension = direct || vscode.extensions.all.find(
    item =>
      item.id.toLowerCase() === GITLAB_EXTENSION_ID.toLowerCase()
  );

  if (!extension) {
    throw new Error(
      `GitLab extension not found. Expected ${GITLAB_EXTENSION_ID}.`
    );
  }

  log(`GitLab extension: ${extension.id}`);
  log(
    `GitLab extension version: ${String(
      extension.packageJSON?.version ?? 'unknown'
    )}`
  );

  if (!extension.isActive) {
    log('Activating GitLab extension...');
    await extension.activate();
  }

  return extension;
}

async function sendToGitLab(prompt) {
  await activateGitLabExtension();

  const commands = new Set(
    await vscode.commands.getCommands(true)
  );

  if (commands.has(GITLAB_SEND_COMMAND)) {
    return vscode.commands.executeCommand(
      GITLAB_SEND_COMMAND,
      { message: prompt }
    );
  }

  await vscode.env.clipboard.writeText(prompt);

  const openCommand = GITLAB_OPEN_COMMANDS.find(command =>
    commands.has(command)
  );

  if (!openCommand) {
    throw new Error(
      `GitLab command ${GITLAB_SEND_COMMAND} is unavailable and ` +
        'no compatible Quick Chat command was found.'
    );
  }

  await vscode.commands.executeCommand(openCommand);

  vscode.window.showWarningMessage(
    `GitLab did not expose ${GITLAB_SEND_COMMAND}. ` +
      'The master prompt was copied; paste it into Quick Chat.'
  );

  return undefined;
}

module.exports = {
  VERIFY_PROMPT,
  PENDING_KEY,
  LAST_PROMPT_KEY,
  LAST_APPLY_KEY,
  getOutput,
  log,
  errorText,
  wait,
  getConfiguration,
  sendToGitLab
};
