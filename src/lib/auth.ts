/** Compatibility wrapper for local/BYOK operations that need no session refresh. */
export async function withSessionRefresh<T>(operation: () => Promise<T>): Promise<T> {
  return operation();
}
