export type AssistantSpeechProvider = "hub" | "local" | "auto";

export function normalizeAssistantSpeechProvider(value: unknown): AssistantSpeechProvider {
  return value === "local" || value === "auto" ? value : "hub";
}

interface MainLink {
  // Tells main the new value; resolves with what main applied.
  send: (value: AssistantSpeechProvider) => Promise<{ provider?: unknown } | undefined>;
  // What main holds right now.
  read: () => Promise<unknown>;
}

interface Deps {
  read: () => AssistantSpeechProvider;
  write: (value: AssistantSpeechProvider) => void;
  warn: (message: string, error: string) => void;
  // Absent outside Electron: the value is then only kept locally.
  main?: () => MainLink | undefined;
}

const NOT_APPLIED = "Assistant speech provider was not applied";

const isProvider = (value: unknown): value is AssistantSpeechProvider =>
  value === "hub" || value === "local" || value === "auto";

// Main owns the setting. Only the LATEST request may touch the store, and
// after it settles the store shows what main reports. Nothing is remembered
// between requests: main is asked, so an older request leaves no trace.
export function createAssistantSpeechProviderSetter(
  deps: Deps
): (value: AssistantSpeechProvider) => void {
  let latest = 0;

  const settle = async (link: MainLink, value: AssistantSpeechProvider, request: number) => {
    try {
      let held: AssistantSpeechProvider | undefined;
      let failure: string | undefined;
      try {
        const answer = await link.send(value);
        if (answer?.provider) held = normalizeAssistantSpeechProvider(answer.provider);
      } catch (err) {
        failure = err instanceof Error ? err.message : String(err);
      }
      if (request !== latest) return;

      if (held === undefined) {
        try {
          const reported = await link.read();
          if (isProvider(reported)) held = reported;
        } catch {
          // Main's value stays unknown.
        }
        if (request !== latest) return;
      }

      if (held !== undefined && held !== deps.read()) deps.write(held);
      if (failure !== undefined) {
        // With main unknown there is nothing trustworthy to roll back to.
        deps.warn(NOT_APPLIED, failure);
      } else if (held !== undefined && held !== value) {
        deps.warn(NOT_APPLIED, `main process holds ${held}, not ${value}`);
      }
    } catch {
      // A throwing store or logger must not become an unhandled rejection.
    }
  };

  return (value) => {
    deps.write(value);
    // Counted before the link check: a change made while the link is absent
    // still makes every older pending request stale.
    const request = ++latest;
    const link = deps.main?.();
    if (!link) return;
    void settle(link, value, request);
  };
}
