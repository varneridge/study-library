import { useEffect, useRef, useState } from "react";
import { lastSignInEmail, requestSignInCode, verifySignInCode } from "../lib/sync";
import { resumeUploads } from "../lib/uploads";
import { pumpChunks } from "../lib/recorder";

// The Worker refuses a second code within a minute, so the button waits as long.
const RESEND_SECONDS = 60;

// Shown in place of the pages while this device has no session. The pages
// stay mounted behind it, so a reading, an essay or a recording carries on
// exactly where it was once the code is in.
export function SignIn() {
  const [step, setStep] = useState<"email" | "code">("email");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [devCode, setDevCode] = useState<string | null>(null);
  const [sentAt, setSentAt] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const codeInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    void lastSignInEmail().then((saved) => setEmail((typed) => typed || saved));
  }, []);

  // The countdown only ticks while the code is being typed.
  useEffect(() => {
    if (step !== "code") return;
    codeInput.current?.focus();
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  const wait = Math.max(0, Math.ceil((sentAt + RESEND_SECONDS * 1000 - now) / 1000));

  async function send() {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const { devCode: shown } = await requestSignInCode(email.trim());
      setDevCode(shown);
      setSentAt(Date.now());
      setNow(Date.now());
      setCode("");
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function verify(value: string) {
    if (busy || value.length !== 6) return;
    setBusy(true);
    setError(null);
    try {
      await verifySignInCode(email.trim(), value);
      void resumeUploads();
      void pumpChunks();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setCode("");
      codeInput.current?.focus();
    } finally {
      setBusy(false);
    }
  }

  return (
    <main id="sign-in" className="page" aria-labelledby="sign-in-title" style={{ maxWidth: "26rem", margin: "12vh auto 0" }}>
      <h1 id="sign-in-title">Sign in to Study Library</h1>

      {step === "email" ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void send();
          }}
        >
          <p className="small muted">
            Enter your email address and a six-digit code will be sent to it, which keeps the library private without a password.
          </p>
          <label className="field" style={{ display: "block", marginTop: "1rem" }}>
            <span>Email address</span>
            <input
              type="email"
              autoComplete="email"
              autoFocus
              required
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={{ width: "100%" }}
            />
          </label>
          <button type="submit" className="button primary" disabled={busy || !email.trim()} style={{ marginTop: "0.75rem" }}>
            {busy ? "Sending…" : "Send code"}
          </button>
        </form>
      ) : (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void verify(code);
          }}
        >
          <p className="small muted">
            If {email.trim()} may sign in, a code is on its way. It lasts ten minutes, and if you asked more than once only the newest code works.
          </p>
          {devCode && (
            <p className="small muted">Development mode has no way to send email, so the code is {devCode}.</p>
          )}
          <label className="field" style={{ display: "block", marginTop: "1rem" }}>
            <span>Six-digit code</span>
            <input
              ref={codeInput}
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              pattern="[0-9]{6}"
              maxLength={6}
              value={code}
              disabled={busy}
              onChange={(e) => {
                // Pasted codes often carry spaces, and six digits sign in at once.
                const digits = e.target.value.replace(/\D/g, "").slice(0, 6);
                setCode(digits);
                if (digits.length === 6) void verify(digits);
              }}
              style={{ width: "100%", letterSpacing: "0.3em", fontVariantNumeric: "tabular-nums" }}
            />
          </label>
          <div style={{ display: "flex", gap: "0.5rem", flexWrap: "wrap", marginTop: "0.75rem" }}>
            <button type="submit" className="button primary" disabled={busy || code.length !== 6}>
              {busy ? "Signing in…" : "Sign in"}
            </button>
            <button type="button" className="button" disabled={busy || wait > 0} onClick={() => void send()}>
              {wait > 0 ? `Send a new code in ${wait}s` : "Send a new code"}
            </button>
            <button
              type="button"
              className="quiet"
              disabled={busy}
              onClick={() => {
                setStep("email");
                setError(null);
                setDevCode(null);
              }}
            >
              Use a different address
            </button>
          </div>
        </form>
      )}

      {error && <p className="small problem" role="alert" style={{ marginTop: "0.75rem" }}>{error}</p>}

      <p className="small muted" style={{ marginTop: "1.5rem" }}>
        Everything saved on this device stays here while you are signed out, and unsent edits are sent once you sign in.
      </p>
    </main>
  );
}
