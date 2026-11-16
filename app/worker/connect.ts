export interface ConnectSecrets {
  PROCESSOR_KEY?: string;
  PROCESSOR_ACCESS_CLIENT_ID?: string;
  PROCESSOR_ACCESS_CLIENT_SECRET?: string;
}

export function accessEmail(jwt: string | undefined): string | null {
  if (!jwt) return null;
  const parts = jwt.split(".");
  if (parts.length !== 3) return null;
  try {
    const raw = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/"));
    const claims = JSON.parse(raw) as { email?: unknown };
    return typeof claims.email === "string" && claims.email.length > 0 ? claims.email : null;
  } catch {
    return null;
  }
}

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
