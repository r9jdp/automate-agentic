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
 * These selectors were observed