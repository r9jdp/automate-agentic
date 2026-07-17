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

function register(commandId, handler) {
  return vscode.commands.registerCommand(commandId, async () => {
    try {
      await handler();
    } catch (error) {
      const message = errorText(error);
      log(`[ERROR] ${message}`);
      getOutput().show(true);
      vscode.window.showErrorMessage(`Duo Agent: ${message}`);
    }
  });
}

function activate(context) {
  context.subscriptions.push(
    getOutput(),
    register('duoAgent.runTask', () => runTask(context)),
    register('duoAgent.applyClipboard', () =>
      applyFromClipboard(context)
    ),
    register('duoAgent.copyLastPrompt', () =>
      copyLastPrompt(context)
    ),
    register('duoAgent.undoLastApply', () =>
      undoLastApply(context)
    ),
    register('duoBridge.verify', verifyStaticSend)
  );
}

function deactivate() {}

module.exports = {
  activate,
  deactivate
};
