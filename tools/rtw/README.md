# `rtw` — local CLI and MCP server for rTech Whisper

`rtw` talks to the rTech Whisper app that is **running on this machine**, over
the app's loopback CLI bridge (`src/helpers/cliBridge.js`). Nothing here reaches
the network: the app publishes `~/.openwhispr/cli-bridge.json` (mode 600) with a
port in `8200-8219` and a per-launch token, and `rtw` reads that file and calls
`127.0.0.1`. If the app is not running there is no bridge file and every command
exits 2 with `rTech Whisper is not running`.

Two front ends over one client (`src/bridge.ts`):

- a CLI that prints JSON on stdout, for shell and `jq` use;
- an MCP server on stdio, so Claude Code and other MCP clients can read and
  write notes.

There is no delete tool and no delete subcommand, deliberately: an agent should
not be able to destroy notes.

## Install

```bash
cd tools/rtw
/opt/homebrew/opt/node@24/bin/npm install
```

Then either run it by path (`tools/rtw/bin/rtw ...`) or put it on `PATH`:

```bash
ln -s "$PWD/bin/rtw" ~/.local/bin/rtw
```

The launcher resolves symlinks before locating `src/`, so the symlink works from
anywhere. It execs Node 24 by absolute path (`/opt/homebrew/opt/node@24/bin/node`)
and runs the TypeScript sources directly — there is no build step.

## CLI

```bash
rtw health                                      # {"ok": true, "version": 1}
rtw notes list --limit 10
rtw notes list --folder 7
rtw notes search "quarterly review" --limit 5
rtw notes get 42
rtw notes create --title "Call notes" --content "..."
rtw notes create --title "Draft" --content-file ./draft.md
rtw notes update 42 --title "Call notes (final)"
rtw folders list
rtw transcriptions list --limit 20
rtw --help
```

Exit codes: `0` success, `2` the app or bridge could not serve the request
(not running, refused, timeout, `unauthorized`, `not_found`), `64` the
invocation was wrong. Errors go to stderr; the token is never printed.

`RTW_BRIDGE_FILE` overrides the bridge-file path (the test suite uses it to
point at a fake bridge).

## MCP

```bash
claude mcp add rtech-whisper -- /absolute/path/to/repo/tools/rtw/bin/rtw mcp
```

Tools: `notes_list`, `notes_search`, `note_get`, `note_create`, `note_update`,
`folders_list`, `transcriptions_list`. Each is a thin pass-through to the
bridge, so the app remains the only definition of what a note is. When the app
is not running, a tool call returns an error result carrying that message rather
than crashing the server.

## Tests

```bash
cd tools/rtw && /opt/homebrew/opt/node@24/bin/npm test
```

The suite starts a fake bridge (`node:http`, port 0) that checks the Bearer
token and serves the same envelope shape as the app, writes a bridge file into a
`test/tmp-*` directory it removes afterwards, and drives the real `bin/rtw` as a
child process — including the MCP server, through the SDK's own client. The real
app is never started and the real bridge file is never read.
