# Duo Agent

Duo Agent is a local VS Code extension that turns a development task into a constrained master prompt, sends that prompt to GitLab Duo Quick Chat, validates the returned Git patch, and applies approved changes on a new local branch.

It supports:

- Dynamic task prompts
- Repository file-tree context
- User-selected context files
- Active editor selection context
- Restricted writable paths
- File creation
- File modification
- Optional file deletion with an additional confirmation
- Patch validation with `git apply --check`
- Patch preview before application
- A new local branch for every applied task
- Prompt-injection boundaries around repository context
- Reviewed saving of unsaved editor documents
- Reversal of the last applied patch when branch history is unchanged

It does not commit, push, open merge requests, execute generated shell commands, access browser cookies, call undocumented GitLab endpoints, or manipulate GitLab's webview DOM.

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
│   ├── patch.js
│   └── workflow.js
└── README.md
```

`extension.js` only registers commands. The `src` modules separate Git execution, path validation, master-prompt construction, patch validation/application, and the interactive workflow. There are no npm dependencies and no build step.

## Workflow

```text
User task
   |
   v
Duo Agent collects approved context
   |
   v
Duo Agent builds a constrained master prompt
   |
   v
GitLab Quick Chat receives the prompt automatically
   |
   v
GitLab Duo produces one machine-readable Git patch
   |
   v
User clicks Copy Snippet on the response
   |
   v
Duo Agent detects the copied response
   |
   v
Paths and patch structure are validated
   |
   v
Patch is opened for review
   |
   v
User approves application
   |
   v
A new local branch is created and files are changed
```

## Why one Copy Snippet click is required

The verified GitLab command can submit a prompt programmatically:

```text
gl.showAndSendDuoQuickChatWithContext
```

However, GitLab's command does not provide a documented response-reading API for another extension. VS Code also isolates one extension's comment UI and webviews from other extensions.

Duo Agent therefore waits for the response to be copied through GitLab Quick Chat's existing **Copy Snippet** action. After that one click, validation, review, branch creation, and file application continue inside Duo Agent.

The extension also inspects the return value of the GitLab command. If a future GitLab extension version returns response text directly, Duo Agent can consume it without the clipboard step.

## Requirements

- VS Code 1.92.2 or later
- Official GitLab extension: `GitLab.gitlab-workflow`
- GitLab Duo non-agentic Quick Chat working in VS Code
- Git installed and available in `PATH`
- A local Git repository with at least one commit
- A trusted VS Code workspace
- A clean Git working tree by default

Check Git:

```powershell
git --version
```

Check the GitLab extension:

```powershell
code --list-extensions | Select-String -Pattern 'GitLab.gitlab-workflow'
```

## Run in the Extension Development Host

Clone and open the extension:

```powershell
git clone https://github.com/r9jdp/automate-agentic.git
cd automate-agentic\duo-bridge-poc
code .
```

No `npm install` command is required.

In VS Code:

1. Press `F5`.
2. A new **Extension Development Host** window opens.
3. In that new window, open the **root folder** of the Git repository you want Duo Agent to modify. Do not open only a nested subfolder.
4. Open a relevant source file.
5. Confirm GitLab Duo Quick Chat works manually.

## Run a task

In the Extension Development Host:

1. Press `Ctrl+Shift+P`.
2. Run:

   ```text
   Duo Agent: Run Reviewed Task
   ```

3. Enter a precise development task.
4. Confirm the repository-relative writable paths.
5. Choose whether deletion is permitted.
6. Select the files GitLab Duo should receive as full context.
7. If files have unsaved changes, approve **Save All and Continue** or cancel.
8. Wait for GitLab Duo Quick Chat to answer.
9. Click **Copy Snippet** on the single response code block.
10. Review the patch that Duo Agent opens.
11. Select **Apply on New Branch** only after checking the paths and diff.

Example task:

```text
Add email-address validation to customer creation. Preserve the public API,
return the existing validation error type, and add unit tests for valid,
invalid, blank, and null values.
```

Example writable paths:

```text
src/Validation, tests/Validation
```

Use `.` only when the task genuinely requires permission to modify the entire repository.

## Generated master-prompt contract

Duo Agent asks GitLab Duo to return one response code block shaped like:

```diff
DUO_AGENT_REQUEST <request-id>
diff --git a/src/example.js b/src/example.js
--- a/src/example.js
+++ b/src/example.js
@@ -1,2 +1,3 @@
 existing line
+new line
DUO_AGENT_END <request-id>
```

The request ID prevents a stale clipboard response from being applied to the wrong task. The master prompt also marks repository file contents, comments, filenames, and selections as untrusted data. Instructions embedded inside repository content are not authoritative and must not change the task, writable scope, or output contract.

If GitLab Duo lacks enough context, it is instructed to return:

```text
DUO_AGENT_REQUEST <request-id>
DUO_AGENT_NO_CHANGES <request-id>
REASON: <specific missing context>
DUO_AGENT_END <request-id>
```

## Safety validation

Before changing files, Duo Agent checks:

- The response belongs to the current request ID
- The response contains a Git unified diff
- Patch size and operation count are within configured limits
- Every path is repository-relative
- Every path is inside the user-approved writable scope
- No path reaches `.git`, `.hg`, or `.svn` metadata directories
- No path escapes through `..`
- Windows device names, alternate-data-stream syntax, and invalid Windows path forms are rejected on Windows
- No path traverses an existing symbolic link or junction
- The patch contains no binary changes
- The patch contains no renames or copies
- The patch creates no symbolic links or submodules
- The patch contains no mode-only changes
- Deletion was approved for the current task
- `git apply --check` succeeds
- The repository still has a valid `HEAD` commit
- Unsaved documents are saved only after explicit approval
- The working tree is still clean before application

The patch is then displayed as a `diff` document. Nothing is applied until the user selects **Apply on New Branch**.

If deletion is present, the user must additionally type:

```text
DELETE
```

## What happens after approval

Duo Agent creates a branch similar to:

```text
duo-agent/20260716163000-add-email-validation
```

It then applies the patch to the working tree.

It does not stage, commit, or push the changes.

Review the result:

```powershell
git status --short
git diff
git diff --check
```

Run the repository's normal tests and static checks before committing.

Examples:

```powershell
dotnet test
```

```powershell
npm test
```

```powershell
pytest
```

## Commands

### `Duo Agent: Run Reviewed Task`

Starts the complete workflow: task input, scope selection, context selection, prompt sending, clipboard wait, validation, preview, and application.

### `Duo Agent: Apply Pending Response from Clipboard`

Use this when automatic clipboard waiting was cancelled or timed out:

1. Copy the complete GitLab Duo response code block.
2. Run this command.

The request ID must match the pending request.

### `Duo Agent: Copy Last Master Prompt`

Copies the most recently generated master prompt. This is useful when GitLab Quick Chat was closed or the prompt must be sent again.

### `Duo Agent: Undo Last Applied Patch`

Runs a reverse dry-run check and, after confirmation, reverses the last patch applied by Duo Agent.

This changes only the working tree. It does not delete the generated branch or rewrite Git history. The command refuses to run from another branch or after new commits have changed the generated branch history.

### `Duo Agent: Verify GitLab Duo Static Send`

Sends the original verification prompt:

```text
Reply with exactly this text and nothing else: DUO_BRIDGE_OK
```

## Settings

Open VS Code Settings and search for `Duo Agent`.

Important settings:

| Setting | Default | Purpose |
|---|---:|---|
| `duoAgent.requireCleanWorkingTree` | `true` | Refuse to operate when existing changes are present |
| `duoAgent.defaultAllowedPaths` | `["."]` | Default writable scope when no active-file directory is available |
| `duoAgent.maxContextFiles` | `12` | Maximum full files sent as context |
| `duoAgent.maxContextCharacters` | `90000` | Combined full-file context limit |
| `duoAgent.maxCharactersPerFile` | `24000` | Per-file or selection context limit |
| `duoAgent.maxTreeEntries` | `500` | Tracked paths added to the prompt |
| `duoAgent.maxPatchBytes` | `1000000` | Maximum accepted patch size |
| `duoAgent.maxOperations` | `50` | Maximum changed-file diff sections |
| `duoAgent.clipboardWaitSeconds` | `600` | Clipboard-wait timeout |

## Troubleshooting

### The command is not visible

In the extension project window, press `F5`. Run Duo Agent commands in the newly opened Extension Development Host, not in the original window.

### GitLab Duo opens but no prompt is sent

Run:

```text
Duo Agent: Verify GitLab Duo Static Send
```

Open **View → Output** and select **Duo Agent**.

The installed GitLab extension must register:

```text
gl.showAndSendDuoQuickChatWithContext
```

### The clipboard wait timed out

Copy the complete response code block and run:

```text
Duo Agent: Apply Pending Response from Clipboard
```

### The response ID does not match

The copied response belongs to an earlier task. Copy the response generated for the latest pending request, or rerun the task.

### Git rejected the patch

Likely causes:

- GitLab Duo used stale file content
- Too few context files were selected
- The repository changed while Duo was responding
- The copied code block was incomplete
- GitLab Duo produced an invalid diff

Regenerate the task with current and more relevant context files.

### Open the repository root

Error:

```text
Open the Git repository root as the VS Code workspace before running Duo Agent.
```

Close the current folder and open the folder that contains the repository's `.git` directory. This prevents the extension from modifying files outside the trusted VS Code workspace.

### The repository has no commits

Create an initial commit before running Duo Agent:

```powershell
git add .
git commit -m "Initial commit"
```

### Unsaved files are detected

Choose **Save All and Continue** to save the listed repository files, or cancel and review them manually. After saving, the normal clean-working-tree check still runs; saved changes must be committed, stashed, or discarded before the task continues.

### The working tree is not clean

Check:

```powershell
git status --short
```

Commit, stash, or remove existing work before rerunning Duo Agent.

## Current scope

This version deliberately uses a reviewed Git-patch workflow. It does not yet:

- Automatically read another extension's private UI state
- Execute tests automatically
- Retry GitLab Duo with compiler errors
- Commit or push changes
- Create merge requests
- Run arbitrary commands proposed by the model
- Apply binary assets
- Perform renames, copies, symlinks, or submodule changes

These boundaries keep the first file-writing version inspectable and reversible. Repository context can contain hostile or misleading text, so the generated master prompt treats that context as data and all returned patches still require structural validation and human approval.
