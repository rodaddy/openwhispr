// MCP server exposing the running rTech Whisper app's notes over stdio.
// Every tool is a thin call to bridge.ts: no business logic lives here, so the
// app stays the single owner of what a note is. Read-only plus create/update —
// deletion is deliberately absent so an agent cannot destroy the user's notes.

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { api, BridgeError } from "./bridge.ts";

export const TOOL_NAMES = [
  "notes_list",
  "notes_search",
  "note_get",
  "note_create",
  "note_update",
  "folders_list",
  "transcriptions_list",
] as const;

type ToolResult = {
  content: { type: "text"; text: string }[];
  isError?: boolean;
};

function ok(data: unknown): ToolResult {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn: () => Promise<unknown>): Promise<ToolResult> {
  try {
    return ok(await fn());
  } catch (err) {
    if (err instanceof BridgeError) {
      return { content: [{ type: "text", text: err.message }], isError: true };
    }
    throw err;
  }
}

export function createServer(): McpServer {
  const server = new McpServer({ name: "rtech-whisper", version: "0.1.0" });

  server.registerTool(
    "notes_list",
    {
      description: "List notes in the running rTech Whisper app, newest first.",
      inputSchema: {
        limit: z.number().int().positive().optional(),
        folder_id: z.number().int().positive().optional(),
        note_type: z.string().optional(),
      },
    },
    async (args) => run(() => api.notesList(args))
  );

  server.registerTool(
    "notes_search",
    {
      description: "Search notes by text and return the matches.",
      inputSchema: {
        query: z.string().min(1),
        limit: z.number().int().positive().optional(),
      },
    },
    async ({ query, limit }) => run(() => api.notesSearch(query, limit))
  );

  server.registerTool(
    "note_get",
    {
      description: "Fetch one note by id, with its full content.",
      inputSchema: { id: z.number().int().positive() },
    },
    async ({ id }) => run(() => api.noteGet(id))
  );

  server.registerTool(
    "note_create",
    {
      description: "Create a note in the app.",
      inputSchema: {
        title: z.string().min(1),
        content: z.string().optional(),
        note_type: z.string().optional(),
        folder_id: z.number().int().positive().optional(),
      },
    },
    async (args) => run(() => api.noteCreate(args))
  );

  server.registerTool(
    "note_update",
    {
      description: "Update an existing note's title and/or content.",
      inputSchema: {
        id: z.number().int().positive(),
        title: z.string().optional(),
        content: z.string().optional(),
      },
    },
    async ({ id, title, content }) => run(() => api.noteUpdate(id, { title, content }))
  );

  server.registerTool(
    "folders_list",
    { description: "List the app's note folders.", inputSchema: {} },
    async () => run(() => api.foldersList())
  );

  server.registerTool(
    "transcriptions_list",
    {
      description: "List recent dictation transcriptions.",
      inputSchema: { limit: z.number().int().positive().optional() },
    },
    async ({ limit }) => run(() => api.transcriptionsList(limit))
  );

  return server;
}

export async function startStdioServer(): Promise<void> {
  const server = createServer();
  await server.connect(new StdioServerTransport());
}
