// `rtw` — the CLI half of the local tools. Prints JSON on stdout so it composes
// with jq; every human-facing message goes to stderr. Exit codes are the
// contract: 0 success, 2 the app/bridge could not serve the request, 64 the
// invocation itself was wrong (EX_USAGE).

import { readFileSync } from "node:fs";
import { parseArgs } from "node:util";
import { api, BridgeError } from "./bridge.ts";

const EXIT_BRIDGE = 2;
const EXIT_USAGE = 64;

const USAGE = `rtw — local CLI for a running rTech Whisper app

Usage:
  rtw health
  rtw notes list [--limit N] [--folder ID]
  rtw notes search <query> [--limit N]
  rtw notes get <id>
  rtw notes create --title T [--content C | --content-file PATH] [--folder ID]
  rtw notes update <id> [--title T] [--content C | --content-file PATH]
  rtw folders list
  rtw transcriptions list [--limit N]
  rtw mcp                      start the MCP server on stdio
  rtw --help

The app must be running: it publishes ~/.openwhispr/cli-bridge.json, which this
CLI reads (override with RTW_BRIDGE_FILE).`;

class UsageError extends Error {}

function print(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function toInt(value: string | undefined, flag: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new UsageError(`${flag} must be a positive integer`);
  }
  return n;
}

function contentOf(values: Record<string, unknown>): string | undefined {
  const content = values.content as string | undefined;
  const file = values["content-file"] as string | undefined;
  if (content !== undefined && file !== undefined) {
    throw new UsageError("use either --content or --content-file, not both");
  }
  if (file === undefined) return content;
  try {
    return readFileSync(file, "utf8");
  } catch {
    throw new UsageError(`cannot read --content-file ${file}`);
  }
}

const OPTIONS = {
  help: { type: "boolean" },
  limit: { type: "string" },
  folder: { type: "string" },
  title: { type: "string" },
  content: { type: "string" },
  "content-file": { type: "string" },
} as const;

function parse(argv: string[]) {
  try {
    return parseArgs({ args: argv, options: OPTIONS, allowPositionals: true });
  } catch (err) {
    throw new UsageError((err as Error).message);
  }
}

async function dispatch(argv: string[]): Promise<void> {
  const { values, positionals } = parse(argv);
  if (values.help) {
    process.stdout.write(`${USAGE}\n`);
    return;
  }
  if (positionals.length === 0) throw new UsageError("no command given");

  const limit = toInt(values.limit as string | undefined, "--limit");
  const folder = toInt(values.folder as string | undefined, "--folder");
  const [group, sub, ...rest] = positionals;

  switch (group) {
    case "health":
      return print(await api.health());

    case "mcp": {
      const { startStdioServer } = await import("./mcp.ts");
      return startStdioServer();
    }

    case "notes":
      switch (sub) {
        case "list":
          return print(await api.notesList({ limit, folder_id: folder }));
        case "search": {
          const query = rest.join(" ").trim();
          if (!query) throw new UsageError("rtw notes search needs a query");
          return print(await api.notesSearch(query, limit));
        }
        case "get": {
          const id = toInt(rest[0], "<id>");
          if (id === undefined) throw new UsageError("rtw notes get needs a note id");
          return print(await api.noteGet(id));
        }
        case "create": {
          const title = values.title as string | undefined;
          if (!title) throw new UsageError("rtw notes create needs --title");
          return print(
            await api.noteCreate({
              title,
              content: contentOf(values) ?? "",
              folder_id: folder,
            })
          );
        }
        case "update": {
          const id = toInt(rest[0], "<id>");
          if (id === undefined) throw new UsageError("rtw notes update needs a note id");
          const title = values.title as string | undefined;
          const content = contentOf(values);
          if (title === undefined && content === undefined) {
            throw new UsageError("rtw notes update needs --title or --content");
          }
          return print(await api.noteUpdate(id, { title, content }));
        }
        default:
          throw new UsageError(`unknown notes subcommand: ${sub ?? "(none)"}`);
      }

    case "folders":
      if (sub !== "list") throw new UsageError(`unknown folders subcommand: ${sub ?? "(none)"}`);
      return print(await api.foldersList());

    case "transcriptions":
      if (sub !== "list") {
        throw new UsageError(`unknown transcriptions subcommand: ${sub ?? "(none)"}`);
      }
      return print(await api.transcriptionsList(limit));

    default:
      throw new UsageError(`unknown command: ${group}`);
  }
}

try {
  await dispatch(process.argv.slice(2));
} catch (err) {
  if (err instanceof UsageError) {
    process.stderr.write(`rtw: ${err.message}\n\n${USAGE}\n`);
    process.exit(EXIT_USAGE);
  }
  if (err instanceof BridgeError) {
    process.stderr.write(`rtw: ${err.message}\n`);
    process.exit(EXIT_BRIDGE);
  }
  throw err;
}
