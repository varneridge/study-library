// Email sign-in: the parts of the Worker's code checks that need no database.
import assert from "node:assert/strict";
import {
  allowedEmails, codeHash, generateCode, generateToken, hmacHex, HOURLY_LIMIT, isAllowed, isCode, isLocalHost, normaliseEmail,
  readCookie, RESEND_COOLDOWN_MS, sha256Hex, shouldTouch, SESSION_TOUCH_MS, throttle, timingSafeEqual,
} from "../worker/authLogic";

type Test = (name: string, fn: () => void) => void;

const MINUTE = 60_000;

export function registerAuthTests(test: Test) {
  test("sign-in addresses are trimmed and lower-cased, and anything else is refused", () => {
    assert.equal(normaliseEmail("  Me@Example.COM "), "me@example.com");
    assert.equal(normaliseEmail("no-at-sign"), null);
    assert.equal(normaliseEmail("two@@example.com"), null);
    assert.equal(normaliseEmail("space in@example.com"), null);
    assert.equal(normaliseEmail(`${"a".repeat(250)}@b.co`), null);
    assert.equal(normaliseEmail(42), null);
  });

  test("the allowlist reads commas, semicolons and spaces, and an empty one admits nobody", () => {
    const list = " Me@Example.com,other@example.com; third@example.com\nfourth@example.com,,";
    assert.deepEqual([...allowedEmails(list)], ["me@example.com", "other@example.com", "third@example.com", "fourth@example.com"]);
    assert.ok(isAllowed("me@example.com", list));
    assert.ok(!isAllowed("stranger@example.com", list));
    assert.ok(!isAllowed("me@example.com", ""));
    assert.ok(!isAllowed("me@example.com", undefined));
  });

  test("a second code waits a minute, and a sixth in the hour is refused", () => {
    const now = 10 * 3_600_000;
    assert.equal(throttle([], now), "ok");
    assert.equal(throttle([now - 30_000], now), "cooldown");
    assert.equal(throttle([now - RESEND_COOLDOWN_MS + 1], now), "cooldown");
    assert.equal(throttle([now - RESEND_COOLDOWN_MS], now), "ok");
    const spaced = (n: number) => Array.from({ length: n }, (_, i) => now - (i + 2) * MINUTE * 5);
    assert.equal(throttle(spaced(HOURLY_LIMIT - 1), now), "ok");
    assert.equal(throttle(spaced(HOURLY_LIMIT), now), "limit");
    // Codes older than an hour no longer count.
    assert.equal(throttle([...spaced(HOURLY_LIMIT - 1), now - 61 * MINUTE, now - 90 * MINUTE], now), "ok");
  });

  test("only six digits count as a code", () => {
    assert.ok(isCode("012345"));
    for (const bad of ["12345", "1234567", "12a456", " 123456", "", null, 123456]) assert.ok(!isCode(bad), String(bad));
  });

  test("secrets compare whole, and differing lengths never match", () => {
    assert.ok(timingSafeEqual("abc123", "abc123"));
    assert.ok(!timingSafeEqual("abc123", "abc124"));
    assert.ok(!timingSafeEqual("abc", "abcd"));
    assert.ok(timingSafeEqual("", ""));
  });

  test("the session cookie is found among others, and a missing one reads as none", () => {
    assert.equal(readCookie("a=1; sl_session=tok_en-1; b=2", "sl_session"), "tok_en-1");
    assert.equal(readCookie("xsl_session=nope", "sl_session"), null);
    assert.equal(readCookie("sl_session=", "sl_session"), null);
    assert.equal(readCookie(null, "sl_session"), null);
  });

  test("a session's last use is written at most hourly", () => {
    assert.ok(!shouldTouch(1_000, 1_000 + SESSION_TOUCH_MS - 1));
    assert.ok(shouldTouch(1_000, 1_000 + SESSION_TOUCH_MS));
  });

  test("dev mode answers only to local names", () => {
    for (const host of ["localhost", "127.0.0.1", "[::1]"]) assert.ok(isLocalHost(host), host);
    for (const host of ["study.example.com", "localhost.example.com", "127.0.0.1.nip.io"]) assert.ok(!isLocalHost(host), host);
  });
}

// Web Crypto is asynchronous, so these run on their own and return how many failed.
export async function runAuthHashTests(): Promise<number> {
  let failed = 0;
  const check = async (name: string, fn: () => Promise<void>) => {
    try {
      await fn();
      console.log(`ok   ${name}`);
    } catch (error) {
      failed += 1;
      console.log(`FAIL ${name}\n${(error as Error).message}`);
    }
  };

  await check("SHA-256 and HMAC-SHA-256 match their published test vectors", async () => {
    assert.equal(await sha256Hex("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    // RFC 4231, test case 2.
    assert.equal(await hmacHex("Jefe", "what do ya want for nothing?"), "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843");
  });

  await check("a code's hash depends on the key, the challenge and the code alike", async () => {
    const base = await codeHash("key", "challenge-1", "123456");
    assert.equal(base, await codeHash("key", "challenge-1", "123456"));
    assert.notEqual(base, await codeHash("other key", "challenge-1", "123456"));
    assert.notEqual(base, await codeHash("key", "challenge-2", "123456"));
    assert.notEqual(base, await codeHash("key", "challenge-1", "123457"));
    assert.match(base, /^[0-9a-f]{64}$/);
  });

  await check("codes are six digits and tokens are 256 bits of base64url, never repeating", async () => {
    const codes = Array.from({ length: 500 }, generateCode);
    assert.ok(codes.every(isCode));
    assert.ok(new Set(codes).size > 490, "codes repeat far more than chance allows");
    const tokens = Array.from({ length: 50 }, generateToken);
    assert.ok(tokens.every((t) => /^[A-Za-z0-9_-]{43}$/.test(t)));
    assert.equal(new Set(tokens).size, tokens.length);
  });

  return failed;
}
