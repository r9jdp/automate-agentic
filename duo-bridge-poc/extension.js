'use strict';

const vscode = require('vscode');
const {
  getOutput,
  log,
  errorText
} = require('./src/runtime');
const {
  runTask,
  applyFromClipboard,
  copyLastPrompt,
  undoLastApply,
  verifyStaticSend
} = require('./src/workflow');

function register(context, commandId, handler) {
  return vscode.commands.registerCommand(commandId, async () => {
    try {
      await handler();
    } catch (error) {
      const message = errorText(error);
      log(`[ERROR] ${message}`);
      vscode.window.showErrorMessage(`Duo Agent: ${message}`);
    }
  });
}

function activate(context) {
  context.subscriptions.push(
    getOutput(),
    register(context, 'duoAgent.runTask', () => runTask(context)),
    register(context, 'duoAgent.applyClipboard', () =>
      applyFromClipboard(context)
    ),
    register(context, 'duoAgent.copyLastPrompt', () =>
      copyLastPrompt(context)
    ),
    register(context, 'duoAgent.undoLastApply', () =>
      undoLastApply(context)
    ),
    register(context, 'duoBridge.verify', verifyStaticSend)
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
