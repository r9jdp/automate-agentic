# Duo Agent

Duo Agent is a local VS Code extension that sends a constrained coding request to GitLab Duo Quick Chat, receives a structured response, previews the proposed file changes, and applies approved changes directly to the branch you are already using.

Version `0.6.0` keeps the interruption-free current-branch workflow and adds bounded, progressive context:

- It does **not** create a new branch for each task.
- It does **not** require a clean working tree, a new commit, or saving every open file before a task.
- Existing unrelated Git changes are left untouched.
- Selected files form an access pool; only the most relevant files are loaded into the initial prompt.
- GitLab Duo can request up to five additional files per round, for at most three rounds.
- Focused changes use compact, exact-text edits instead of returning whole files.
- Unsaved text is read directly when an editor file is loaded as context.

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
    │   ├── context.js
    │   ├── prompt.js
    │   ├── operations.js
    │   └── workflow.js
    └── test/
        ├── protocol.test.js
        ├── context.test.js
        ├── workflow.test.js
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
6. Select existing files GitLab Duo may inspect. The active file is preselected by default.
7. Check the context summary showing accessible files, loaded files, and prompt characters.
8. Wait for GitLab Duo to answer and click **Copy Snippet**.
9. If Duo requests more context, Duo Agent loads approved files and sends the next round automatically. Click **Copy Snippet** again when it answers.
10. Review the final diff opened by Duo Agent.
11. Click **Apply Changes**.

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

## Progressive context

Selecting a file gives Duo Agent permission to load it for the current task. It does not mean the complete file is immediately placed in the prompt.

For the first round, Duo Agent prioritizes:

1. The active file
2. Paths named in the task
3. Other open editor files
4. Files inside the writable scope
5. Remaining selected files

The generated prompt, including instructions and the repository inventory, must fit `duoAgent.maxPromptCharacters`. Files that do not fit remain listed as available but unloaded.

If GitLab Duo needs an unloaded file, it returns a structured context request. Files already in the selected pool load automatically. A file outside the pool requires a separate read-access confirmation. Every round receives a new request ID, so an older copied response cannot be applied to a newer round.

After three rounds, Duo Agent stops without changing files and recommends splitting the task. It also stops if the branch or any previously loaded file changes while context is being gathered.

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

- Existing files must have been loaded as complete context before Duo may change them.
- Their SHA-256 hashes must still match when the response is applied.
- Unrelated modified or untracked files are ignored and preserved.
- If a target file changes after the prompt was sent, Duo Agent stops and asks you to run the task again.

This means you can work with a dirty Git tree without giving the model permission to overwrite unrelated work.

## Unsaved editor files

Duo Agent does not display **Save All and Continue** before each task.

For context files that are open in VS Code:

- The current editor buffer is used, including unsaved text.
- GitLab Duo receives that exact content and its SHA-256 hash.
- If the file was already unsaved, an approved replacement is applied to the editor buffer and remains unsaved.
- If the file was clean, Duo Agent applies and saves the replacement.

Deleting an open unsaved file is blocked to prevent data loss. Save or close that file before a deletion task.

## What the internal JSON response means

GitLab Duo returns strict JSON describing proposed file changes. Focused changes use exact old-text/new-text anchors; broad rewrites can still return complete replacement content. This is an internal safety protocol, not an additional action you need to perform.

The supported internal actions are:

```text
create   Create a new text file
replace  Replace the complete contents of an existing text file
edit     Replace exact, unique text inside an existing file
delete   Delete an existing file after explicit approval
```

The UI describes this as **proposed file changes**.

A typical internal response looks like:

```json
{
  "protocol": "duo-agent-json-v2",
  "requestId": "exact-request-id",
  "summary": "Update trial.py",
  "operations": [
    {
      "op": "edit",
      "path": "trial.py",
      "expectedSha256": "hash-from-the-selected-file-context",
      "edits": [
        {
          "oldText": "print(\"old\")",
          "newText": "print(\"new\")"
        }
      ]
    }
  ]
}
```

Normally, you only click **Copy Snippet**. A large task can require more than one copied response while Duo Agent gathers context.

## After Copy Snippet

Duo Agent first determines whether the copied response requests context or proposes changes.

For a context request, it:

1. Checks that the response belongs to the current round.
2. Validates and normalizes every requested path.
3. Confirms access if a requested file was not already selected.
4. Revalidates the branch and previously loaded file hashes.
5. Loads the files that fit and sends the next bounded prompt.

For proposed changes, it:

1. Verifies the existing-file hashes and compact-edit anchors.
2. Constructs the complete final contents locally.
3. Creates a normal diff preview.
4. Asks for approval.
5. Applies only the approved files on the current branch.
6. Verifies the final file contents.
7. Stores enough information for **Undo Last Changes**.

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

## Context settings

The important context defaults are:

```text
duoAgent.maxContextPoolFiles       100
duoAgent.maxContextFiles            12
duoAgent.maxContextCharacters    45000
duoAgent.maxPromptCharacters     60000
duoAgent.maxContextRounds            3
duoAgent.targetResponseCharacters 24000
```

`maxContextPoolFiles` controls how many files may be available to a task. `maxContextFiles` and `maxContextCharacters` limit complete loaded context. `maxPromptCharacters` applies to the final serialized prompt, not just file contents. Raising these limits can increase model latency and timeout risk.

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
- Context-pool ranking and complete-prompt budgeting
- Progressive context requests, approval, and stale-snapshot rejection
- Binary and over-budget context handling
- Compact edit insertion, replacement, deletion, ambiguity, and overlap checks
- UTF-8 BOM and line-ending preservation
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
- Existing-file changes without full loaded context
- Missing, ambiguous, overlapping, or no-op compact edits
- Context requests with unsafe, duplicate, unknown, or excessive paths
- Context and prompt budget overflow
- Stale file hashes
- Stale responses from another task or context round
- Branch changes while a response is pending
- Deletion of an unsaved open file

It does not execute model-generated commands, manipulate GitLab's DOM, access browser cookies, commit, push, or create branches.
