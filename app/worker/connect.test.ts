import test from "node:test";
import assert from "node:assert/strict";
import { accessEmail, connectLink } from "./connect";

function makeJwt(payload: Record<string, unknown>): string {
  const header = btoa(JSON.stringify({ alg: "RS256", typ: "JWT" })).replace(/=/g, "");
  const body = btoa(JSON.stringify(payload)).replace(/=/g, "");
  return `${header}.${body}.signature`;
}

test("accessEmail parses email from a valid JWT", () => {
  const jwt = makeJwt({ email: "user@example.com", sub: "123" });
  assert.equal(accessEmail(jwt), "user@example.com");
});

test("accessEmail returns null for service token JWT without email claim", () => {
  const jwt = makeJwt({ sub: "service-token-id", type: "app" });
  assert.equal(accessEmail(jwt), null);
});

test("accessEmail returns null for malformed or missing token", () => {
  assert.equal(accessEmail(undefined), null);
  assert.equal(accessEmail(""), null);
  assert.equal(accessEmail("not-a-jwt"), null);
  assert.equal(accessEmail("a.bad-json.c"), null);
});

test("connectLink generates the golden string when all secrets are set", () => {
  const golden =
    "studylibrary://connect?v=1&PROCESSOR_KEY=a%2Bb%2Fc%3D&CF_ACCESS_CLIENT_ID=0f.access&CF_ACCESS_CLIENT_SECRET=ff";
  const link = connectLink({
    PROCESSOR_KEY: "a+b/c=",
    PROCESSOR_ACCESS_CLIENT_ID: "0f.access",
    PROCESSOR_ACCESS_CLIENT_SECRET: "ff",
  });
  assert.equal(link, golden);
});

test("connectLink returns null when any secret is missing or empty", () => {
  assert.equal(connectLink({}), null);
  assert.equal(
    connectLink({
      PROCESSOR_KEY: "key",
      PROCESSOR_ACCESS_CLIENT_ID: "id",
    }),
    null
  );
  assert.equal(
    connectLink({
      PROCESSOR_KEY: "",
      PROCESSOR_ACCESS_CLIENT_ID: "id",
      PROCESSOR_ACCESS_CLIENT_SECRET: "secret",
    }),
    null
  );
});
