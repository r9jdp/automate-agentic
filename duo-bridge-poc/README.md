# Duo Bridge POC

A minimal VS Code extension that verifies whether one extension can send a fixed prompt to GitLab Duo Quick Chat through VS Code's command API.

## Project structure

```text
duo-bridge-poc/
├── package.json
├── extension.js
└── README.md
```

No npm dependencies, build step, TypeScript compiler, HTML, CSS, ZIP file, or browser extension is required.

## DOM elements observed

The screenshots show these GitLab Duo webview elements:

```text
Input:
[data-testid="chat-prompt-input"]

Submit button:
[data-testid="chat-prompt-submit-button"]
```

The input also had a generated ID similar to:

```text
__BVID__25
```

Do not depend on that generated ID because it can change between sessions.

These selectors are retained in `extension.js` for diagnostics only. A normal VS Code extension runs in the Extension Host and cannot query or modify another extension's isolated webview DOM. Therefore this POC uses GitLab's registered VS Code command instead of attempting unsupported DOM injection.

## Verification prompt

The extension attempts to submit:

```text
Reply with exactly this text and nothing else: DUO_BRIDGE_OK
```

A successful result is:

```text
DUO_BRIDGE_OK
```

## Run locally

Clone the repository:

```powershell
git clone https://github.com/r9jdp/automate-agentic.git
cd automate-agentic\duo-bridge-poc
code .
```

No `npm install` command is required.

In VS Code:

1. Confirm the official GitLab extension is installed and signed in.
2. Confirm GitLab Duo Chat works manually.
3. Open `duo-bridge-poc`.
4. Press `F5`.
5. A new Extension Development Host window opens.
6. In that new window, open an actual source-code project or file.
7. Press `Ctrl+Shift+P`.
8. Run `Duo Bridge: Verify Static Send`.

## Full-success path

The extension looks for this GitLab command:

```text
gl.showAndSendDuoQuickChatWithContext
```

When available, it executes the command with:

```javascript
{
  message: 'Reply with exactly this text and nothing else: DUO_BRIDGE_OK'
}
```

GitLab Duo Quick Chat should open and submit the fixed prompt automatically.

## Fallback path

When the auto-send command is not exposed by the installed GitLab extension version, the extension:

1. Copies the fixed prompt to the clipboard.
2. Opens GitLab Duo Quick Chat using an available `gl.*` command.
3. Shows a warning explaining that automatic submission was unavailable.

You can also explicitly run:

```text
Duo Bridge: Copy Prompt and Open Chat
```

This always copies the prompt and opens Quick Chat without trying to submit it.

## Diagnostics

Open:

```text
View → Output
```

Select:

```text
Duo Bridge POC
```

The output shows:

- GitLab extension ID and version
- Whether the GitLab extension activated
- Every detected `gl.*` command
- Whether the auto-send command was found
- Which fallback command was used
- The observed DOM selectors from the screenshots
- Any execution error

## Expected outcomes

### Full success

The output contains:

```text
Executing: gl.showAndSendDuoQuickChatWithContext
Static prompt was submitted through GitLab command API.
```

GitLab Duo responds with:

```text
DUO_BRIDGE_OK
```

### Partial success

Quick Chat opens and the prompt is copied, but it is not submitted.

This means:

- The custom extension loaded correctly.
- The GitLab extension was detected.
- Cross-extension command execution works.
- The installed GitLab build does not expose the internal auto-send command.

### GitLab extension not found

Check the installed extension ID:

```powershell
code --list-extensions | Select-String -Pattern 'gitlab'
```

Expected:

```text
GitLab.gitlab-workflow
```

## Scope

This proof of concept only verifies a fixed static prompt. It does not yet:

- Read dynamic prompts
- Read selected code
- Add files as context
- Parse responses
- Create or edit files
- Run tests
- Commit or push code
- Access the GitLab webview DOM

Dynamic prompt input should only be added after the static-send verification succeeds.
