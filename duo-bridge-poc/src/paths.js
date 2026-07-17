'use strict';

const path = require('path');
const fs = require('fs/promises');

function repositoryPath(repositoryRoot, absolutePath) {
  const relative = path.relative(
    path.resolve(repositoryRoot),
    path.resolve(absolutePath)
  );

  if (!relative || relative === '.') {
    return '.';
  }

  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    return undefined;
  }

  return relative.split(path.sep).join('/');
}

function normalizeRepositoryPath(value, options = {}) {
  const allowRoot = options.allowRoot === true;
  let normalized = String(value ?? '')
    .trim()
    .replace(/\\/g, '/');

  while (normalized.startsWith('./')) {
    normalized = normalized.slice(2);
  }

  normalized = normalized.replace(/\/+$/g, '');

  if (allowRoot && (normalized === '' || normalized === '.')) {
    return '.';
  }

  if (!normalized) {
    throw new Error('Repository-relative path cannot be empty.');
  }

  if (
    normalized.startsWith('/') ||
    /^[A-Za-z]:/.test(normalized) ||
    /[\u0000-\u001f\u007f]/.test(normalized)
  ) {
    throw new Error(`Unsafe path: ${value}`);
  }

  const blockedMetadata = new Set(['.git', '.hg', '.svn']);

  for (const segment of normalized.split('/')) {
    if (
      !segment ||
      segment === '.' ||
      segment === '..' ||
      blockedMetadata.has(segment.toLowerCase())
    ) {
      throw new Error(`Unsafe path: ${value}`);
    }

    if (process.platform === 'win32') {
      const deviceName = segment.split('.')[0].toLowerCase();

      if (
        /[<>:"|?*]/.test(segment) ||
        /[ .]$/.test(segment) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/.test(deviceName)
      ) {
        throw new Error(`Unsafe Windows path: ${value}`);
      }
    }
  }

  return normalized.split('/').join('/');
}

function parseAllowedPaths(input) {
  const values = String(input)
    .split(',')
    .map(value => value.trim())
    .filter(Boolean)
    .map(value =>
      normalizeRepositoryPath(value, { allowRoot: true })
    );

  if (values.length === 0) {
    throw new Error('Provide at least one writable path.');
  }

  return [...new Set(values)];
}

function pathKey(value) {
  return process.platform === 'win32'
    ? value.toLowerCase()
    : value;
}

function isPathAllowed(relativePath, allowedPaths) {
  const candidate = pathKey(relativePath);

  return allowedPaths.some(base => {
    const normalizedBase = pathKey(base);

    return (
      normalizedBase === '.' ||
      candidate === normalizedBase ||
      candidate.startsWith(`${normalizedBase}/`)
    );
  });
}

function absoluteRepositoryPath(repositoryRoot, relativePath) {
  const root = path.resolve(repositoryRoot);
  const target = path.resolve(
    root,
    ...relativePath.split('/')
  );
  const relative = path.relative(root, target);

  if (
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  ) {
    throw new Error(`Path escapes repository: ${relativePath}`);
  }

  return target;
}

async function requireNoSymlinkTraversal(
  repositoryRoot,
  relativePath
) {
  const target = absoluteRepositoryPath(
    repositoryRoot,
    relativePath
  );
  const root = path.resolve(repositoryRoot);
  const relative = path.relative(root, target);
  let current = root;

  for (const segment of relative.split(path.sep)) {
    current = path.join(current, segment);

    try {
      const stat = await fs.lstat(current);

      if (stat.isSymbolicLink()) {
        throw new Error(
          `Path traverses a symlink or junction: ${relativePath}`
        );
      }
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        break;
      }

      throw error;
    }
  }
}

module.exports = {
  repositoryPath,
  normalizeRepositoryPath,
  parseAllowedPaths,
  pathKey,
  isPathAllowed,
  absoluteRepositoryPath,
  requireNoSymlinkTraversal
};
