'use strict';

const path = require('path');
const { spawn } = require('child_process');
const { errorText } = require('./runtime');

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true
    });

    let stdout = '';
    let stderr = '';

    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', error => {
      reject(
        new Error(
          `Could not start ${command}: ${errorText(error)}`
        )
      );
    });
    child.on('close', exitCode => {
      const result = {
        exitCode: exitCode ?? -1,
        stdout,
        stderr
      };

      if (!options.allowFailure && result.exitCode !== 0) {
        reject(
          new Error(
            `${command} ${args.join(' ')} failed ` +
              `(${result.exitCode})\n${stderr || stdout}`
          )
        );
        return;
      }

      resolve(result);
    });

    if (options.input !== undefined) {
      child.stdin.end(options.input, 'utf8');
    } else {
      child.stdin.end();
    }
  });
}

function git(repositoryRoot, args, options = {}) {
  return run('git', args, {
    ...options,
    cwd: repositoryRoot
  });
}

async function resolveRepositoryRoot(folder) {
  if (folder.uri.scheme !== 'file') {
    throw new Error(
      'Duo Agent requires a local file-system Git checkout.'
    );
  }

  const workspaceRoot = path.resolve(folder.uri.fsPath);
  const result = await git(
    workspaceRoot,
    ['rev-parse', '--show-toplevel']
  );
  const repositoryRoot = path.resolve(result.stdout.trim());

  if (path.relative(workspaceRoot, repositoryRoot) !== '') {
    throw new Error(
      'Open the Git repository root as the VS Code workspace ' +
        'before running Duo Agent.'
    );
  }

  return repositoryRoot;
}

async function requireHead(repositoryRoot) {
  const result = await git(
    repositoryRoot,
    ['rev-parse', '--verify', 'HEAD'],
    { allowFailure: true }
  );

  if (result.exitCode !== 0 || !result.stdout.trim()) {
    throw new Error(
      'Repository must have at least one commit before Duo Agent ' +
        'can create a branch.'
    );
  }

  return result.stdout.trim();
}

async function currentBranch(repositoryRoot) {
  const result = await git(
    repositoryRoot,
    ['branch', '--show-current']
  );

  return result.stdout.trim();
}

async function requireClean(repositoryRoot, configuration) {
  if (!configuration.requireCleanWorkingTree) {
    return;
  }

  const result = await git(repositoryRoot, [
    'status',
    '--porcelain=v1',
    '--untracked-files=all'
  ]);

  if (result.stdout.trim()) {
    throw new Error(
      'Git working tree is not clean. Commit, stash, or discard ' +
        `existing changes.\n\n${result.stdout.trim()}`
    );
  }
}

async function trackedFiles(repositoryRoot, maximum) {
  const result = await git(
    repositoryRoot,
    ['ls-files', '-z']
  );

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map(file => file.replace(/\\/g, '/'))
    .filter(file => !file.startsWith('.git/'))
    .slice(0, maximum);
}

module.exports = {
  git,
  resolveRepositoryRoot,
  requireHead,
  currentBranch,
  requireClean,
  trackedFiles
};
