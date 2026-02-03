# Coverage Status

A minimal VS Code extension that displays code coverage percentage in the status bar by reading `coverage/*.lcov`.

## Setup

```bash
cd coverage-status
npm install
npm run compile
# Press F5 in VS Code to open Extension Development Host
```

## How it works

The extension watches `coverage/*.lcov` and updates the status bar automatically. Use the command "Coverage Status: Refresh" from the Command Palette to force an update.

## Per-file behavior
 - The status bar shows coverage for the active editor file when LCOV data maps to that file. Matching tries exact absolute path first, then filename with path-suffix scoring when duplicates exist.

## Configuration
 - `coverageStatus.lcovGlob` (array of globs) — customize which LCOV files are searched (default `['**/lcov.info','**/*.lcov']`).

## QuickPick
 - Use the command palette command "Coverage Status: Show files" to view per-file percentages and inspect uncovered lines.
