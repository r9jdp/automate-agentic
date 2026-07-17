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

async function currentBranch(repositoryRoot) {
  const result = await git(
    repositoryRoot,
    ['branch', '--show-current'],
    { allowFailure: true }
  );

  return result.stdout.trim();
}

async function currentHead(repositoryRoot) {
  const result = await git(
    repositoryRoot,
    ['rev-parse', '--verify', 'HEAD'],
    { allowFailure: true }
  );

  return result.exitCode === 0 ? result.stdout.trim() : undefined;
}

async function repositoryFiles(repositoryRoot, maximum) {
  const result = await git(
    repositoryRoot,
    [
      'ls-files',
      '--cached',
      '--others',
      '--exclude-standard',
      '-z'
    ]
  );

  return result.stdout
    .split('\0')
    .filter(Boolean)
    .map(file => file.replace(/\\/g, '/'))
    .filter(file => !file.startsWith('.git/'))
    .sort((left, right) => left.localeCompare(right))
    .slice(0, maximum);
}

async function statusSummary(repositoryRoot) {
  const result = await git(
    repositoryRoot,
    ['status', '--porcelain=v1', '--untracked-files=all'],
    { allowFailure: true }
  );

  return result.stdout.trim();
}

module.exports = {
  git,
  resolveRepositoryRoot,
  currentBranch,
  currentHead,
  repositoryFiles,
  trackedFiles: repositoryFiles,
  statusSummary
};
