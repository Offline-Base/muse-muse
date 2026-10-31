// Platform file: don't edit. Every way a session can start. A Quest offers its own Enter VR prompt when the store sets
// offerSession, and a session from that prompt never goes through requestSession.
type Start = (mode: XRSessionMode, init?: XRSessionInit) => Promise<XRSession>;

/** Calls `onStart` with each session the page gets, however it started. */
export function watchSessions(xr: XRSystem, onStart: (session: XRSession) => void): void {
  const system = xr as unknown as { requestSession: Start; offerSession?: Start };
  for (const method of ["requestSession", "offerSession"] as const) {
    const original = system[method]?.bind(xr);
    if (!original) continue;
    system[method] = async (mode, init) => {
      const session = await original(mode, init);
      onStart(session);
      return session;
    };
  }
}
