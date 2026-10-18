// Copies the PDF.js worker into public/ so it is served from the same origin
// and cached by the service worker for offline reading.
import { copyFileSync, existsSync } from "node:fs";

const source = "node_modules/pdfjs-dist/build/pdf.worker.min.mjs";
if (existsSync(source)) copyFileSync(source, "public/pdf.worker.min.mjs");
