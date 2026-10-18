import "@fontsource-variable/literata";
// Literata's optical-size cut, loaded as its own family for page titles only,
// so the reading text and its saved places are untouched by it.
import "./display-font.css";
import "@fontsource/ibm-plex-sans/400.css";
import "@fontsource/ibm-plex-sans/500.css";
import "@fontsource/ibm-plex-sans/600.css";
import "./styles.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { applyAppearance, storedAppearance } from "./lib/appearance";

// After a deploy, a tab opened earlier may ask for parts of the app that
// no longer exist. Reloading once brings the new version in.
window.addEventListener("vite:preloadError", (event) => {
  if (sessionStorage.getItem("reloaded-for-update")) return;
  sessionStorage.setItem("reloaded-for-update", "1");
  event.preventDefault();
  location.reload();
});
window.addEventListener("load", () => setTimeout(() => sessionStorage.removeItem("reloaded-for-update"), 10_000));

// Apply light or dark before the first paint, so the page never flashes.
applyAppearance(storedAppearance());

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);

if ("serviceWorker" in navigator && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js");
}
