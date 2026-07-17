# Duo Agent

Duo Agent is a local VS Code extension that sends a constrained coding request to GitLab Duo Quick Chat, receives a structured response, previews the proposed file changes, and applies approved changes directly to the branch you are already using.

Version `0.5.0` removes the main workflow interruptions from earlier versions:

- It does **not** create a new branch for each task.
- It does **not** require a clean working tree, a new commit, or saving every open file before a task.
- Existing unrelated Git changes are left untouched.
- Unsaved text in selected editor files is read directly and sent as the current file content.

## Repository structure

```text
automate-agentic/
├── README.md
└── duo-bridge-poc/
    ├── package.json
    ├── extension.js
    ├── src/
    │   ├── runtime.js
    │   ├── git.js
    │   ├── paths.js
    │   ├── prompt.js
    │   ├── operations.js
    │   └── workflow.js
    └── test/
        ├── protocol.test.js
        └── operations.test.js
```

There are no runtime npm dependencies and no build step.

## Requirements

- VS Code 1.92.2 or later
- Official GitLab extension: `GitLab.gitlab-workflow`
- GitLab Duo non-agentic Quick Chat working in VS Code
- Git installed and available in `PATH`
- A local Git repository with at least one commit
- A trusted VS Code workspace

## Start the extension

Clone and open the extension project:

```powershell
git clone https://github.com/r9jdp/automate-agentic.git
cd automate-agentic\duo-bridge-poc
code .
```

For an existing clone:

```powershell
cd C:\path\to\automate-agentic
git pull
cd duo-bridge-poc
code .
```

Optional test run:

```powershell
npm test
```

Press `F5`. VS Code opens an **Extension Development Host** window.

In that new window, open the root directory of the Git repository you want to edit.

## Run a coding task

1. Open the main file related to the task.
2. Press `Ctrl+Shift+P`.
3. Run:

   ```text
   Duo Agent: Run Code Task
   ```

4. Enter the task.
5. Confirm the files or folders GitLab Duo may change. The active file is suggested automatically.
6. Select any existing files GitLab Duo should read. The active file is preselected by default.
7. Wait for GitLab Duo to answer.
8. Click **Copy Snippet** on the response code block.
9. Review the diff opened by Duo Agent.
10. Click **Apply Changes**.

Example task:

```text
Refactor trial.py into small functions, validate the input, preserve the current
entry point, and keep the existing behavior for valid values.
```

Example writable scope:

```text
trial.py
```

For a task that can create files in two directories:

```text
src/validation, tests/validation
```

## Current-branch behavior

Duo Agent applies changes to the branch that was active when the task was sent.

It does not run:

```text
git switch -c
git commit
git push
```

If you switch branches while GitLab Duo is responding, the extension refuses to apply the stale response. Run the task again on the new branch.

## Existing uncommitted changes

You do not need to commit or stash before every task.

Duo Agent validates only the files it is about to change:

- Existing files must be selected as complete context.
- Their SHA-256 hashes must still match when the response is applied.
- Unrelated modified or untracked files are ignored and preserved.
- If a target file changes after the prompt was sent, Duo Agent stops and asks you to run the task again.

This means you can work with a dirty Git tree without giving the model permission to overwrite unrelated work.

## Unsaved editor files

Duo Agent does not display **Save All and Continue** before each task.

For selected files that are open in VS Code:

- The current editor buffer is used, including unsaved text.
- GitLab Duo receives that exact content and its SHA-256 hash.
- If the file was already unsaved, an approved replacement is applied to the editor buffer and remains unsaved.
- If the file was clean, Duo Agent applies and saves the replacement.

Deleting an open unsaved file is blocked to prevent data loss. Save or close that file before a deletion task.

## What the internal JSON response means

GitLab Duo returns complete file changes in a strict JSON code block instead of a fragile Git patch. This is an internal safety protocol; it is not an additional action you need to perform.

The supported internal actions are:

```text
create   Create a new text file
replace  Replace the complete contents of an existing text file
delete   Delete an existing file after explicit approval
```

The UI describes this as **proposed file changes**.

A typical internal response looks like:

```json
{
  "protocol": "duo-agent-json-v1",
  "requestId": "exact-request-id",
  "summary": "Update trial.py",
  "operations": [
    {
      "op": "replace",
      "path": "trial.py",
      "expectedSha256": "hash-from-the-selected-file-context",
      "content": "Complete final content for trial.py\n"
    }
  ]
}
```

Normally, you only click **Copy Snippet**. Duo Agent parses and validates the JSON automatically.

## After Copy Snippet

Duo Agent automatically:

1. Checks that the response belongs to the current task.
2. Validates every file path.
3. Verifies the selected existing-file hashes.
4. Creates a normal diff preview from the complete proposed file contents.
5. Asks for approval.
6. Applies only the approved files on the current branch.
7. Verifies the final file contents.
8. Stores enough information for **Undo Last Changes**.

If automatic clipboard detection times out, run:

```text
Duo Agent: Apply Copied Response
```

## Review preview tabs

The diff preview is temporary review content, not a project source file. Do not save it as a separate file. Close the preview after applying or rejecting the proposed changes.

## Deletion

Duo Agent only asks about deletion when the task appears to request removing files.

If the response actually deletes a file, you must review the diff and type:

```text
DELETE
```

## Commands

```text
Duo Agent: Run Code Task
Duo Agent: Apply Copied Response
Duo Agent: Copy Last Generated Prompt
Duo Agent: Undo Last Changes
Duo Agent: Verify GitLab Duo Connection
```

## Review and commit when ready

After an apply:

```powershell
git branch --show-current
git status --short
git diff
git diff --check
```

Run the appropriate tests. Commit only when the current group of changes is ready:

```powershell
git add .
git commit -m "Implement requested change"
git push
```

Duo Agent never commits or pushes automatically.

## Tests

From `duo-bridge-poc`:

```powershell
npm test
```

The test suite covers:

- Strict JSON response parsing
- Unsafe-path rejection
- Current-branch application
- Operation with an already-dirty Git working tree
- Preservation of unrelated modified files
- Reading and editing an unsaved VS Code buffer without saving it first

## Safety boundaries

Duo Agent blocks:

- Absolute paths and `..` traversal
- `.git`, `.hg`, and `.svn` paths
- Existing symbolic links and junctions
- Binary or NUL-containing files
- Unknown JSON fields or unsupported actions
- Duplicate or parent/child-conflicting file changes
- Existing-file changes without full selected context
- Stale file hashes
- Stale responses from another task
- Branch changes while a response is pending
- Deletion of an unsaved open file

It does not execute model-generated commands, manipulate GitLab's DOM, access browser cookies, commit, push, or create branches.
