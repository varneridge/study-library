// "Speech on this computer" under Processor and speech in Settings, in the
// desktop app only: which Kokoro engine this computer's speech server runs
// (backend/tts/server.py, health), and the high-quality speech pack for
// computers with an NVIDIA card (backend/study/speech_pack.py), installed or
// removed through a studylibrary:// link that the desktop app handles.

import { useEffect, useState } from "react";

const HEALTH = "http://127.0.0.1:8765/tts/v1/health";

export interface SpeechHealth {
  engine?: string;
  device?: string;
  precision?: string;
  tier?: string;
  pack?: boolean;
  nvidia?: boolean;
}

/** The status line for a health report, in words. */
export function describeSpeech(h: SpeechHealth | null): string {
  if (!h) return "The speech server on this computer is not answering yet. It starts with the desktop app.";
  if (h.engine === "torch" && h.device === "cuda") return "High-quality speech on the graphics card. This computer prepares Listen audio first.";
  if (h.engine === "torch") return "High-quality speech on the processor, because the graphics card is not available.";
  if (h.device === "gpu") return "Standard speech on the graphics card.";
  if (h.precision === "int8") return "The compressed voice model. This computer does not prepare Listen audio.";
  return "Standard speech on the processor. This computer prepares Listen audio when no computer with a graphics card is on.";
}

export function SpeechState() {
  const [health, setHealth] = useState<SpeechHealth | null>(null);
  const [asked, setAsked] = useState(false);

  useEffect(() => {
    let stopped = false;
    const check = async () => {
      try {
        const response = await fetch(HEALTH, { cache: "no-store" });
        if (!stopped) setHealth(response.ok ? ((await response.json()) as SpeechHealth) : null);
      } catch {
        if (!stopped) setHealth(null);
      }
    };
    void check();
    const timer = setInterval(check, 10_000);
    return () => {
      stopped = true;
      clearInterval(timer);
    };
  }, []);

  const open = (action: "install" | "remove") => {
    setAsked(true);
    window.location.href = `studylibrary://speech-pack?action=${action}`;
  };

  return (
    <>
      <h3 className="settings-subhead">Speech on this computer</h3>
      <p className="small">{describeSpeech(health)}</p>
      {health?.nvidia && !health.pack && (
        <>
          <p className="small muted">
            High-quality speech pronounces ordinary words better, times each word exactly and prepares a long reading in a minute or two on this
            computer's NVIDIA card. It downloads about 3 GB.
          </p>
          <button type="button" className="button" disabled={asked} onClick={() => open("install")}>
            Install high-quality speech
          </button>
        </>
      )}
      {health?.pack && (
        <button type="button" className="quiet danger" disabled={asked} onClick={() => open("remove")}>
          Remove high-quality speech
        </button>
      )}
      {asked && <p className="small muted">Study Library shows its progress in notifications. This section updates when it finishes.</p>}
    </>
  );
}
