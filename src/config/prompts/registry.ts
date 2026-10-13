import { en as enPrompts, type PromptBundle } from "../../locales/prompts";
import { SKIPPY_PERSONA_PROMPT } from "./skippyPersona";
import { GRILL_INTERVIEWER_PROMPT } from "./grillPrompt";

// When changing this text, move its old hash to the retired set in
// src/config/retiredPrompts.js and update the current-hash snapshot there.

export const PROMPT_KINDS = {
  cleanup: {
    i18nKey: "cleanupPrompt" as const,
    fallback: enPrompts.cleanupPrompt,
  },
  dictationAgent: {
    i18nKey: "fullPrompt" as const,
    fallback: enPrompts.fullPrompt,
  },
  translate: {
    i18nKey: "translatePrompt" as const,
    fallback: enPrompts.translatePrompt,
  },
  chatAgent: {
    i18nKey: null,
    fallback: SKIPPY_PERSONA_PROMPT,
  },
  grill: {
    i18nKey: null,
    fallback: GRILL_INTERVIEWER_PROMPT,
  },
} as const satisfies Record<string, { i18nKey: keyof PromptBundle | null; fallback: string }>;

export type PromptKind = keyof typeof PROMPT_KINDS;
export const PROMPT_KIND_LIST = Object.keys(PROMPT_KINDS) as readonly PromptKind[];
