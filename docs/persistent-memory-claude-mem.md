# Persistent Memory with claude-mem

This guide explains a minimal-risk way to run `claude-mem` with OpenClaude so context can persist across sessions while keeping token usage under control.

## Scope and Compatibility

- OpenClaude supports plugin hooks and command hooks, which `claude-mem` relies on.
- `claude-mem` was built for Claude Code first, so treat this as an integration path that should be validated in your environment.
- On Windows, OpenClaude hook defaults use `bash` for command hooks unless otherwise configured.

## Prerequisites

- Node.js `>=20` (OpenClaude runtime requirement)
- Git
- Bun available in PATH (recommended by both projects)
- A working OpenClaude install

## 1) Clone claude-mem once

If you already cloned it, skip this step.

```powershell
mkdir "C:\Users\elias\git"
git clone "https://github.com/thedotmack/claude-mem.git" "C:\Users\elias\git\claude-mem"
```

## 2) Install claude-mem plugin/hooks

Install with the official installer:

```powershell
npx claude-mem install
```

Restart OpenClaude after install.

## 3) Multi-user Windows setup (optional but recommended)

If the OpenClaude workspace is under another Windows user profile (for example `C:\Users\marco\git\openclaude`) and you run OpenClaude as `elias`, mark the repo as safe for Git:

```powershell
git config --global --add safe.directory "C:/Users/marco/git/openclaude"
```

This avoids Git ownership warnings without duplicating repository downloads.

## 4) Validate worker health

`claude-mem` runs a local worker/web viewer. Validate that it is available:

- Open <http://localhost:37777>
- Or check health endpoint:

```powershell
curl http://localhost:37777/health
```

## 5) Use token-efficient memory retrieval

Use the layered lookup pattern in memory queries:

1. `search` for compact result IDs
2. `timeline` around relevant IDs
3. `get_observations` only for final filtered IDs

This keeps memory lookups cheaper than loading full history each session.

## Notes about OpenClaude memdir

OpenClaude already has a native memory subsystem under `src/memdir`.

- Start by validating `claude-mem` behavior without changing memdir defaults.
- If prompts become too memory-heavy, tune one system at a time.
- Avoid introducing two independent "always inject everything" memory paths.

## Troubleshooting

- If hooks fail on Windows, verify Bash/Pwsh availability and PATH resolution.
- If memory is not appearing across sessions, check `claude-mem` worker status and hook logs first.
- If Git warns about ownership, prefer `safe.directory` for cross-user access.
