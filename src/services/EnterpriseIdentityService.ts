import type { ManagedEnterpriseConfig, ManagedEnterpriseScope } from "../types/enterpriseIdentity";

export interface ManagedEnterpriseConfigResult {
  success: boolean;
  status?: "network" | "current" | "cached" | "error";
  accountId?: string | null;
  workspaceId?: string | null;
  authGeneration?: number | null;
  config?: ManagedEnterpriseConfig;
  code?: string;
  error?: string;
  enforcementRequired?: boolean;
  enforcedScopes?: ManagedEnterpriseScope[];
}

export async function getManagedEnterpriseConfig(
  accountId: string,
  workspaceId: string,
  authGeneration: number,
  forceRefresh = false
): Promise<ManagedEnterpriseConfigResult> {
  const request = window.electronAPI?.getManagedEnterpriseConfig;
  // Main registers no managed-config handler and preload exposes no bridge, so
  // the shipped app always lands here: no managed config for this identity.
  if (!request) {
    return { success: true, status: "current", accountId, workspaceId, authGeneration };
  }
  // The IPC boundary type carries scope names as bare strings (see
  // src/types/electron.ts); the main process only ever populates them from
  // ManagedEnterpriseScope values (see managedScopesForConfig).
  return request(
    accountId,
    workspaceId,
    authGeneration,
    forceRefresh
  ) as Promise<ManagedEnterpriseConfigResult>;
}

export function clearManagedEnterpriseIdentity(): void {
  void window.electronAPI?.clearManagedEnterpriseIdentity?.();
}
