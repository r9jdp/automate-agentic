'use strict';

const vscode = require('vscode');

const GITLAB_EXTENSION_ID = 'GitLab.gitlab-workflow';
const AUTO_SEND_COMMAND = 'gl.showAndSendDuoQuickChatWithContext';
const OPEN_COMMANDS = [
  'gl.openQuickChat',
  'gl.openQuickChatWithShortcut',
  'gl.openChat'
];

const TEST_PROMPT =
  'Reply with exactly this text and nothing else: DUO_BRIDGE_OK';

/*
 * Observed in the GitLab Duo webview shown in the supplied screenshots.
 * These are diagnostic references only. A normal VS Code extension runs in
 * the Extension Host and cannot query or mutate another extension's webview.
 */
const OBSERVED_DUO_DOM = Object.freeze({
  input: '[data-testid="chat-prompt-input"]',
  submit: '[data-testid="chat-prompt-submit-button"]'
});

function getErrorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function findGitLabExtension() {
  const direct = vscode.extensions.getExtension(GITLAB_EXTENSION_ID);

  if (direct) {
    return direct;
  }

  const expected = GITLAB_EXTENSION_ID.toLowerCase();
  return vscode.extensions.all.find(
    extension => extension.id.toLowerCase() === expected
  );
}

async function activateGitLabExtension(output) {
  const gitLabExtension = findGitLabExtension();

  if (!gitLabExtension) {
    throw new Error(
      `GitLab extension not found. Expected: ${GITLAB_EXTENSION_ID}`
    );
  }

  const version = String(
    gitLabExtension.packageJSON?.version ?? 'unknown'
  );

  output.appendLine(`GitLab extension: ${gitLabExtension.id}`);
  output.appendLine(`GitLab version: ${version}`);
  output.appendLine(`GitLab active: ${gitLabExtension.isActive}`);

  if (!gitLabExtension.isActive) {
    output.appendLine('Activating GitLab extension...');
    await gitLabExtension.activate();
    output.appendLine('GitLab extension activated.');
  }
}

async function getGitLabCommands(output) {
  const commands = await vscode.commands.getCommands(true);
  const gitLabCommands = commands
    .filter(command => command.startsWith('gl.'))
    .sort();

  output.appendLine('');
  output.appendLine(`Detected ${gitLabCommands.length} gl.* commands:`);

  for (const command of gitLabCommands) {
    output.appendLine(`  ${command}`);
  }

  return new Set(commands);
}

async function openQuickChat(commandSet, output) {
  const openCommand = OPEN_COMMANDS.find(command => commandSet.has(command));

  if (!openCommand) {
    throw new Error('No compatible GitLab Duo Quick Chat command was found.');
  }

  output.appendLine(`Opening Quick Chat with: ${openCommand}`);
  await vscode.commands.executeCommand(openCommand);
}

async function runStaticVerification(output) {
  output.clear();
  output.show(true);
  output.appendLine('Duo Bridge static-send verification started.');
  output.appendLine(`Time: ${new Date().toISOString()}`);
  output.appendLine(`Observed input selector: ${OBSERVED_DUO_DOM.input}`);
  output.appendLine(`Observed submit selector: ${OBSERVED_DUO_DOM.submit}`);
  output.appendLine('DOM selectors are not accessed by this extension.');
  output.appendLine('');

  if (!vscode.window.activeTextEditor) {
    throw new Error('Open a source-code file before running verification.');
  }

  await activateGitLabExtension(output);
  const commandSet = await getGitLabCommands(output);

  output.appendLine('');

  if (commandSet.has(AUTO_SEND_COMMAND)) {
    output.appendLine(`Executing: ${AUTO_SEND_COMMAND}`);
    output.appendLine(`Prompt: ${TEST_PROMPT}`);

    await vscode.commands.executeCommand(AUTO_SEND_COMMAND, {
      message: TEST_PROMPT
    });

    output.appendLine('Static prompt was submitted through GitLab command API.');

    vscode.window.showInformationMessage(
      'Duo Bridge sent the static prompt. Expect DUO_BRIDGE_OK.'
    );
    return;
  }

  await vscode.env.clipboard.writeText(TEST_PROMPT);
  await openQuickChat(commandSet, output);

  output.appendLine('');
  output.appendLine(`Unavailable command: ${AUTO_SEND_COMMAND}`);
  output.appendLine('The static prompt was copied to the clipboard.');

  vscode.window.showWarningMessage(
    'Quick Chat opened, but GitLab did not expose the auto-send command. ' +
      'The static prompt is on your clipboard.'
  );
}

async function copyPromptAndOpen(output) {
  output.clear();
  output.show(true);
  output.appendLine('Copy-and-open verification started.');

  await activateGitLabExtension(output);
  const commandSet = await getGitLabCommands(output);

  await vscode.env.clipboard.writeText(TEST_PROMPT);
  output.appendLine('Static prompt copied to clipboard.');

  await openQuickChat(commandSet, output);

  vscode.window.showInformationMessage(
    'GitLab Duo Quick Chat opened and the verification prompt was copied.'
  );
}

function activate(context) {
  const output = vscode.window.createOutputChannel('Duo Bridge POC');

  const verifyCommand = vscode.commands.registerCommand(
    'duoBridge.verify',
    async () => {
      try {
        await runStaticVerification(output);
      } catch (error) {
        const message = getErrorMessage(error);
        output.appendLine('');
        output.appendLine(`[ERROR] ${message}`);
        vscode.window.showErrorMessage(
          `Duo Bridge verification failed: ${message}`
        );
      }
    }
  );

  const copyAndOpenCommand = vscode.commands.registerCommand(
    'duoBridge.copyAndOpen',
    async () => {
      try {
        await copyPromptAndOpen(output);
      } catch (error) {
        const message = getErrorMessage(error);
        output.appendLine('');
        output.appendLine(`[ERROR] ${message}`);
        vscode.window.showErrorMessage(
          `Duo Bridge copy/open failed: ${message}`
        );
      }
    }
  );

  context.subscriptions.push(
    output,
    verifyCommand,
    copyAndOpenCommand
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
