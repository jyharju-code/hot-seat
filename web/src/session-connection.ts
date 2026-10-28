export const CONNECTION_LOST_MESSAGE = "Connection lost.";

export interface ConnectionLostUpdate {
  error: string;
  live: false;
  showStartAgain: true;
}

/** UI update when the session socket closes unexpectedly (e.g. server restart). */
export function connectionLostUpdate(): ConnectionLostUpdate {
  return { error: CONNECTION_LOST_MESSAGE, live: false, showStartAgain: true };
}
