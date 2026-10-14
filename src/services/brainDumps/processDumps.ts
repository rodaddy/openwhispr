import type { BrainDumpResult, NoteItem } from "../../types/electron";

export interface ProcessDumpsDeps {
  /** brain-dumps:list: the waiting dumps and the sorting system prompt. */
  list: () => Promise<{ dumps: NoteItem[]; systemPrompt: string }>;
  /** One model call: the raw reply for one dump. */
  classify: (systemPrompt: string, content: string) => Promise<string>;
  /** brain-dumps:process with the raw replies keyed by note id. */
  process: (outputs: Record<number, string>) => Promise<BrainDumpResult[]>;
  onProgress?: (current: number, total: number) => void;
}

// Brain-dump Process, renderer side: list the dumps, run each through
// the model one at a time, then hand the raw replies to the engine. A dump
// whose model call fails gets no reply; the engine reports it "Not classified".
export async function processDumps(deps: ProcessDumpsDeps) {
  const { dumps, systemPrompt } = await deps.list();
  const outputs: Record<number, string> = {};
  let firstError: unknown;
  let failures = 0;
  for (const [index, dump] of dumps.entries()) {
    deps.onProgress?.(index + 1, dumps.length);
    try {
      outputs[dump.id] = await deps.classify(systemPrompt, dump.content);
    } catch (error) {
      // Left out on purpose; the other dumps still run.
      if (failures === 0) firstError = error;
      failures += 1;
    }
  }
  // Every call failed: the cause is shared (no model set up, offline),
  // so say it once instead of a list of "Not classified" rows.
  if (dumps.length > 0 && failures === dumps.length) {
    throw firstError instanceof Error ? firstError : new Error(String(firstError));
  }
  const results = await deps.process(outputs);
  return { dumps, results };
}
