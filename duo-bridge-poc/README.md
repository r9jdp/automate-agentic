# Duo Agent

Duo Agent is a local VS Code extension that turns a development request into a constrained master prompt, sends it to GitLab Duo Quick Chat, validates the copied JSON response, and applies approved text-file operations on a new local Git branch.

Version `0.4.0` replaces the previous unified-diff workflow with a strict JSON operation protocol. GitLab Duo now returns complete final file contents, so the extension no longer depends on `git apply` matching exact patch context.

## Supported operations

- Create a new UTF-8 text file
- Replace the complete contents of an existing UTF-8 text file
- Delete an existing file when deletion was explicitly allowed
- Preview all proposed changes before writing
- Create a separate local branch for each applied task
- Undo the last applied operation plan when no later edits or commits interfere

Duo Agent does not commit, push, open merge requests, execute model-generated commands, manipulate GitLab's DOM, access browser cookies, or modify files outside the approved writable scope.

## Project structure

```text
duo-bridge-poc/
├── package.json
├── extension.js
├── src/
│   ├── runtime.js
│   ├── git.js
│   ├── paths.js
│   ├── prompt.js
│   ├── operations.js
│   └── workflow.js
├── test/
│   └── protocol.test.js
└── README.md
```

There are no npm dependencies and no build step.

## Requirements

- VS Code 1.92.2 or later
- Official GitLab extension: `GitLab.gitlab-workflow`
- GitLab Duo non-agentic Quick Chat working in VS Code
- Git installed and available in `PATH`
- A local Git repository with at least one commit
- A trusted VS Code workspace
- A clean Git working tree by default

## Start the extension

```powershell
git clone https://github.com/r9jdp/automate-agentic.git
cd automate-agentic\duo-bridge-poc
code .
```

If you already cloned it:

```powershell
git pull
cd duo-bridge-poc
code .
```

Press `F5`. VS Code opens an **Extension Development Host** window.

In that new window, open the **root directory** of the Git repository you want Duo Agent to modify. Do not open only a nested subdirectory.

## Run a task

1. Open a relevant source file.
2. Press `Ctrl+Shift+P`.
3. Run `Duo Agent: Run Reviewed Task`.
4. Enter the development task.
5. Enter the repository-relative writable paths.
6. Choose whether deletion is allowed.
7. Select complete context files.
8. Wait for GitLab Duo to answer.
9. Click **Copy Snippet** on the JSON response.
10. Review the generated diff preview.
11. Click **Apply on New Branch**.

Example task:

```text
Replace trial.py with a function that prints odd numbers below a supplied limit.
Preserve the existing entry point and add clear input validation.
```

Example writable path:

```text
trial.py
```

For a feature spanning multiple directories:

```text
src/validation, tests/validation
```

Use `.` only in a controlled test repository when the task genuinely requires permission to modify the entire repository.

## Context-file selection is important

A new file can be created without existing-file context.

An existing file can be replaced or deleted only when you selected that complete file in the context picker. Duo Agent records the file's SHA-256 hash and includes it in the master prompt. GitLab Duo must return that exact hash in the JSON operation. The extension then verifies the current file still has the same hash before applying anything.

An active editor selection is supplementary context only. Selecting a few lines does not authorize replacement or deletion of the entire file.

## JSON response protocol

GitLab Duo is instructed to return exactly one `json` code block and no surrounding prose.

Successful response:

```json
{
  "protocol": "duo-agent-json-v1",
  "requestId": "the-exact-request-id",
  "summary": "Brief description of the changes",
  "operations": [
    {
      "op": "create",
      "path": "src/new-file.js",
      "content": "Complete final UTF-8 file content\n"
    },
    {
      "op": "replace",
      "path": "src/existing-file.js",
      "expectedSha256": "exact-hash-from-file-context",
      "content": "Complete final UTF-8 replacement content\n"
    },
    {
      "op": "delete",
      "path": "src/obsolete-file.js",
      "expectedSha256": "exact-hash-from-file-context"
    }
  ]
}
```

Only required operations should be included.

No-change response:

```json
{
  "protocol": "duo-agent-json-v1",
  "requestId": "the-exact-request-id",
  "noChanges": true,
  "reason": "Specific missing context or reason"
}
```

The parser rejects comments, trailing commas, unknown fields, unsupported operation types, duplicate paths, stale request IDs, and malformed JSON.

## What happens after Copy Snippet

The extension polls the clipboard for the current request ID. When it detects a valid response, it automatically:

1. Parses the JSON with `JSON.parse`.
2. Validates the protocol and request ID.
3. Validates every operation and path.
4. Rechecks the current Git revision and working tree.
5. Verifies SHA-256 hashes for existing files.
6. Generates a review diff from the proposed complete file contents.
7. Asks for explicit approval.
8. Creates a new local branch.
9. Writes, creates, or deletes files transactionally.
10. Verifies the resulting file hashes.

If clipboard monitoring times out, copy the JSON code block and run:

```text
Duo Agent: Apply Pending JSON Response from Clipboard
```

## File-writing behavior

For `create`, the path must not exist. Parent directories are created automatically.

For `replace`, the complete file is written. When `duoAgent.preserveExistingEol` is enabled, the extension preserves the existing file's dominant line ending and UTF-8 BOM.

For `delete`, deletion must have been allowed when the task was started. After review, the extension also requires you to type:

```text
DELETE
```

If any operation fails after the branch is created, Duo Agent attempts to roll back all operations already performed. If rollback restores a clean working tree, it returns to the original branch and removes the failed generated branch.

## Safety checks

Before writing, Duo Agent checks:

- The workspace is trusted
- The repository root is open in VS Code
- The repository has a valid `HEAD` commit
- The working tree is clean when configured
- The response uses `duo-agent-json-v1`
- The response request ID matches the pending task
- Response and file sizes are within configured limits
- Every path is repository-relative and in the approved writable scope
- `.git`, `.hg`, and `.svn` paths are blocked
- `..`, absolute paths, Windows device names, and invalid Windows path forms are blocked
- Existing symbolic links and junctions are blocked
- Every existing-file operation uses a selected full-file context hash
- Current file hashes still match the captured context
- Duplicate and parent/child-conflicting file operations are rejected
- Only UTF-8 text content is accepted
- The user reviews the generated diff before application

## Commands

### `Duo Agent: Run Reviewed Task`

Starts the complete workflow.

### `Duo Agent: Apply Pending JSON Response from Clipboard`

Parses and applies the copied JSON response for the current pending request.

### `Duo Agent: Copy Last Master Prompt`

Copies the latest generated master prompt so it can be resent to GitLab Duo.

### `Duo Agent: Undo Last Applied Operation Plan`

Restores files to their pre-apply state when you are still on the generated branch, no new commits exist, and the affected files have not been changed again.

### `Duo Agent: Verify GitLab Duo Static Send`

Sends:

```text
Reply with exactly this text and nothing else: DUO_BRIDGE_OK
```

## Review and commit

After a successful apply:

```powershell
git branch --show-current
git status --short
git diff
git diff --check
```

Run the appropriate tests and static checks for the project, then commit manually:

```powershell
git add .
git commit -m "Implement requested change"
git push -u origin HEAD
```

## Settings

Search VS Code Settings for `Duo Agent`.

| Setting | Default | Purpose |
|---|---:|---|
| `duoAgent.requireCleanWorkingTree` | `true` | Refuse existing working-tree changes |
| `duoAgent.defaultAllowedPaths` | `["."]` | Default writable scope |
| `duoAgent.maxContextFiles` | `12` | Maximum complete context files |
| `duoAgent.maxContextCharacters` | `90000` | Combined context-character limit |
| `duoAgent.maxCharactersPerFile` | `24000` | Per-context-file character limit |
| `duoAgent.maxResponseBytes` | `1000000` | Maximum copied JSON response size |
| `duoAgent.maxFileWriteBytes` | `500000` | Maximum size of one created or replaced file |
| `duoAgent.maxTotalWriteBytes` | `2000000` | Maximum total bytes written in one task |
| `duoAgent.maxOperations` | `50` | Maximum file operations in one task |
| `duoAgent.preserveExistingEol` | `true` | Preserve replacement-file EOL and BOM |
| `duoAgent.clipboardWaitSeconds` | `600` | Clipboard monitoring timeout |

## Test the JSON protocol

No installation is required:

```powershell
npm test
```

This tests valid create, replace, delete, and no-change responses, code-fence handling, stale request rejection, unknown fields, unsafe paths, and writable-scope matching.

## Troubleshooting

### Old patch-protocol request

After upgrading from `0.3.x`, discard any pending old response and run a new task. Old unified-diff responses are intentionally rejected.

### Copy Snippet does not continue

Open **View → Output** and select **Duo Agent**. Then run:

```text
Duo Agent: Apply Pending JSON Response from Clipboard
```

The most common cause is invalid JSON or a response for an older request.

### Invalid JSON

Ask GitLab Duo to regenerate exactly one JSON code block with:

- Double-quoted keys and strings
- Escaped newlines inside `content`
- No comments
- No trailing commas
- No prose outside the code block

### Existing file was not supplied as complete context

Run the task again and select that full file in the context picker.

### File changed after context was collected

The file changed while GitLab Duo was responding. Commit, stash, or discard the change, then run a new task.

### Working tree is not clean

```powershell
git status --short
```

Commit, stash, or discard existing work before rerunning Duo Agent.
