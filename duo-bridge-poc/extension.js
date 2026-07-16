'use strict';

const vscode = require('vscode');

async function activate(context) {
  const command = vscode.commands.registerCommand('duoBridge.verify', async () => {
    const output = vscode.window.createOutputChannel('Duo Bridge POC');
    output.show(true);

    output.appendLine('Starting Duo Bridge verification...');

    const commands = await vscode.commands.getCommands(true);
    const target = 'gl.showAndSendDuoQuickChatWithContext';

    output.appendLine(`GitLab auto send command available: ${commands.includes(target)}`);

    if (commands.includes(target)) {
      await vscode.commands.executeCommand(target, {
        message: 'Reply exactly: DUO_BRIDGE_OK'
      });
      output.appendLine('Prompt sent to GitLab Duo.');
      return;
    }

    if (commands.includes('gl.openQuickChat')) {
      await vscode.commands.executeCommand('gl.openQuickChat');
      output.appendLine('Quick Chat opened. Auto send command unavailable.');
      return;
    }

    vscode.window.showErrorMessage('GitLab Duo commands not found.');
  });

  context.subscriptions.push(command);
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
