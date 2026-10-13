/** Local-only compatibility surface for guest-aware UI. */
export const LOCAL_ONLY_AUTH_STATE = Object.freeze({
  isSignedIn: false,
  isGracePeriodOnly: false,
  isLoaded: true,
  session: null,
  user: null,
});

export function useAuth() {
  return { ...LOCAL_ONLY_AUTH_STATE, refetch: async () => null };
}
