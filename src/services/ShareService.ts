import type { ShareFailure, ShareResult, ShareStatus } from "../types/electron";

/**
 * Renderer-side wrapper over the `share-*` IPC channels. The bearer token lives
 * in the main process (src/helpers/shareClient.js) and never reaches here.
 */

const MISSING_BRIDGE: ShareFailure = { ok: false, code: "share_not_configured" };

export const ShareService = {
  async status(): Promise<ShareStatus> {
    const api = window.electronAPI;
    if (!api?.shareStatus) return { configured: false, baseUrl: "" };
    return api.shareStatus();
  },

  async create(note: { id: number; title: string; markdown: string }): Promise<ShareResult> {
    const api = window.electronAPI;
    if (!api?.shareCreate) return MISSING_BRIDGE;
    return api.shareCreate(note.id, note.title, note.markdown);
  },

  async update(token: string, note: { title: string; markdown: string }): Promise<ShareResult> {
    const api = window.electronAPI;
    if (!api?.shareUpdate) return MISSING_BRIDGE;
    return api.shareUpdate(token, note.title, note.markdown);
  },

  async rotate(token: string): Promise<ShareResult> {
    const api = window.electronAPI;
    if (!api?.shareRotate) return MISSING_BRIDGE;
    return api.shareRotate(token);
  },

  async revoke(token: string): Promise<{ ok: true } | ShareFailure> {
    const api = window.electronAPI;
    if (!api?.shareRevoke) return MISSING_BRIDGE;
    return api.shareRevoke(token);
  },
};

/** Rebuilds a share link from a persisted token, without a round trip. */
export function shareLink(baseUrl: string, token: string): string {
  return `${baseUrl}/n/${token}`;
}
