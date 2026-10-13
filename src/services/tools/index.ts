import { ToolRegistry } from "./ToolRegistry";
import { createSearchNotesTool } from "./searchNotesTool";
import { getNoteTool } from "./getNoteTool";
import { createNoteTool } from "./createNoteTool";
import { updateNoteTool } from "./updateNoteTool";
import { listFoldersTool } from "./listFoldersTool";
import { clipboardTool } from "./clipboardTool";
import { calendarTool } from "./calendarTool";
import { calendarAvailabilityTool } from "./calendarAvailabilityTool";
import { attachNoteToCrmContactTool, findCrmContactTool } from "./crmTools";
import type { ContainerScope } from "../../types/chat";
import type { RequestNoteDestination } from "./noteDestination";

export { ToolRegistry } from "./ToolRegistry";
export type { ToolDefinition, ToolResult } from "./ToolRegistry";

interface ToolRegistrySettings {
  isSignedIn: boolean;
  calendarConnected: boolean;
  cloudBackupEnabled: boolean;
  /** Pins search_notes to a container (overview chat); the LLM cannot widen it. */
  searchScope?: ContainerScope;
  webSearchEnabled: boolean;
  requestNoteDestination?: RequestNoteDestination;
  getNoteDestinationCancellationGeneration?: () => number;
}

export function createToolRegistry(settings: ToolRegistrySettings): ToolRegistry {
  const registry = new ToolRegistry();

  const useCloudSearch = settings.isSignedIn && settings.cloudBackupEnabled;
  registry.register(createSearchNotesTool({ useCloudSearch, fixedScope: settings.searchScope }));
  registry.register(getNoteTool);
  registry.register(
    createNoteTool({
      requestNoteDestination: settings.requestNoteDestination,
      getNoteDestinationCancellationGeneration: settings.getNoteDestinationCancellationGeneration,
    })
  );
  registry.register(
    updateNoteTool({
      requestNoteDestination: settings.requestNoteDestination,
      getNoteDestinationCancellationGeneration: settings.getNoteDestinationCancellationGeneration,
    })
  );
  registry.register(listFoldersTool);
  registry.register(clipboardTool);
  registry.register(findCrmContactTool);
  registry.register(attachNoteToCrmContactTool);

  if (settings.calendarConnected) {
    registry.register(calendarTool);
    registry.register(calendarAvailabilityTool);
  }

  return registry;
}
