import reasoningService from "../ReasoningService";
import {
  getSettings,
  selectIsCloudNoteFormattingMode,
  selectPolicyEffectiveSettings,
  selectResolvedNoteFormatting,
} from "../../stores/settingsStore";
import { buildNoteFormattingOverrides } from "../../helpers/noteFormattingOverrides";
import { getLongInputTimeoutSeconds } from "../../helpers/llmRequestTimeout.js";
import type { PolicyDecisionSnapshot } from "../../stores/policyRules";

/** One call to the app's configured note model (brain-dump Process and roundups). */
export function callNoteModel(
  policyState: PolicyDecisionSnapshot,
  systemPrompt: string,
  content: string
): Promise<string> {
  const settings = selectPolicyEffectiveSettings(getSettings(), policyState);
  const noteFormatting = selectResolvedNoteFormatting(settings);
  const isCloudMode = selectIsCloudNoteFormattingMode(settings);
  return reasoningService.processText(content, noteFormatting.model, null, {
    systemPrompt,
    temperature: 0.3,
    disableThinking: settings.noteFormattingDisableThinking,
    timeoutSeconds: getLongInputTimeoutSeconds(content.length + systemPrompt.length),
    ...buildNoteFormattingOverrides(noteFormatting, isCloudMode),
  });
}
