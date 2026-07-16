# Duo Bridge POC

A minimal VS Code extension to verify integration with GitLab Duo from another extension.

## Structure

```
duo-bridge-poc/
├── package.json
├── extension.js
└── README.md
```

## Run locally

Open this folder in VS Code.

Press:

```
F5
```

This starts an Extension Development Host.

In the new VS Code window:

1. Open a code file.
2. Press Ctrl+Shift+P.
3. Run:

```
Duo Bridge: Verify
```

## Expected result

If GitLab Duo exposes the programmatic command, the extension sends:

```
Reply exactly: DUO_BRIDGE_OK
```

Otherwise it opens GitLab Quick Chat and reports the available status.

## Important

This project does not use DOM manipulation. VS Code extensions cannot directly access the workbench DOM. It uses VS Code command APIs to communicate with the GitLab extension.
