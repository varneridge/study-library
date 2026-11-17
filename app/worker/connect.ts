export interface ConnectSecrets {
  PROCESSOR_KEY?: string;
  PROCESSOR_ACCESS_CLIENT_ID?: string;
  PROCESSOR_ACCESS_CLIENT_SECRET?: string;
}

// The link the desktop app opens to become the background processor. It
// carries the service token the processor signs in with, so it is only made
// for a person signed in by email (index.ts checks that).
export function connectLink(env: ConnectSecrets): string | null {
  const { PROCESSOR_KEY, PROCESSOR_ACCESS_CLIENT_ID, PROCESSOR_ACCESS_CLIENT_SECRET } = env;
  if (!PROCESSOR_KEY || !PROCESSOR_ACCESS_CLIENT_ID || !PROCESSOR_ACCESS_CLIENT_SECRET) {
    return null;
  }
  const params = new URLSearchParams({
    v: "1",
    PROCESSOR_KEY,
    CF_ACCESS_CLIENT_ID: PROCESSOR_ACCESS_CLIENT_ID,
    CF_ACCESS_CLIENT_SECRET: PROCESSOR_ACCESS_CLIENT_SECRET,
  });
  return `studylibrary://connect?${params.toString()}`;
}
