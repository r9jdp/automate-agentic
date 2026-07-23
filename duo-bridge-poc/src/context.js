'use strict';

const path = require('path');
const { isPathAllowed, pathKey } = require('./paths');

function normalizedTask(task) {
  return String(task ?? '')
    .replace(/\\/g, '/')
    .toLowerCase();
}

function taskMentionsPath(task, file) {
  const text = normalizedTask(task);
  const normalizedFile = String(file).replace(/\\/g, '/').toLowerCase();
  const basename = path.posix.basename(normalizedFile);

  return (
    text.includes(normalizedFile) ||
    (basename.length >= 3 && text.includes(basename))
  );
}

function rankContextFiles(options) {
  const {
    files,
    activePath,
    task,
    openPaths = [],
    allowedPaths = []
  } = options;
  const activeKey = activePath ? pathKey(activePath) : undefined;
  const openKeys = new Set(openPaths.map(pathKey));

  return [...new Set(files)].map((file, index) => {
    const key = pathKey(file);
    let rank = 4;

    if (activeKey && key === activeKey) {
      rank = 0;
    } else if (taskMentionsPath(task, file)) {
      rank = 1;
    } else if (openKeys.has(key)) {
      rank = 2;
    } else if (isPathAllowed(file, allowedPaths)) {
      rank = 3;
    }

    return { file, index, rank };
  })
    .sort((left, right) =>
      left.rank - right.rank ||
      left.index - right.index ||
      left.file.localeCompare(right.file)
    )
    .map(item => item.file);
}

function buildContextCatalog(files, loadedFiles) {
  const loaded = new Set(loadedFiles.map(pathKey));

  if (files.length === 0) {
    return '- No files were made available.';
  }

  return files
    .map(file => {
      const state = loaded.has(pathKey(file))
        ? 'FULL CONTENT LOADED'
        : 'AVAILABLE, NOT LOADED';
      return `- ${file} [${state}]`;
    })
    .join('\n');
}

function contextLimitReason(options) {
  const {
    fileCount,
    contentCharacters,
    nextContentCharacters,
    projectedPromptCharacters,
    maxFiles,
    maxContextCharacters,
    maxCharactersPerFile,
    maxPromptCharacters
  } = options;

  if (nextContentCharacters > maxCharactersPerFile) {
    return 'per-file limit';
  }

  if (fileCount >= maxFiles) {
    return 'file-count limit';
  }

  if (
    contentCharacters + nextContentCharacters >
    maxContextCharacters
  ) {
    return 'context-character limit';
  }

  if (projectedPromptCharacters > maxPromptCharacters) {
    return 'prompt-character limit';
  }

  return undefined;
}

module.exports = {
  taskMentionsPath,
  rankContextFiles,
  buildContextCatalog,
  contextLimitReason
};
