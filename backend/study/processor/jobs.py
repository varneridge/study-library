"""Job handlers.

Each handler receives a Context and a job. Raising any exception counts as a
failure, which the Worker retries with backoff.
"""

from __future__ import annotations

import hashlib
import logging
import os
import re
import shutil
import subprocess
import tempfile
from dataclasses import dataclass, field
from typing import Callable

from ..api import Api
from .speech import Transcriber
from . import identify as finder

log = logging.getLogger("study.processor")

# A page counts as having no text below this many characters.
MIN_TEXT_CHARS = 25
# OCR runs when more than this share of pages have no text.
OCR_PAGE_SHARE = 0.2
OCR_TIMEOUT = 60 * 60
# One page may take this long before Tesseract gives up on it, so a single
# bad page cannot hold up a whole reading.
OCR_PAGE_TIMEOUT = 300
# Readings in History come in English, French and German most often. Each
# language is used only if its Tesseract pack is installed.
OCR_LANGUAGES = os.environ.get("OCR_LANGUAGES", "eng+fra+deu")
# Two-page book spreads are split into single pages before OCR.
SPLIT_SPREADS = os.environ.get("SPLIT_SPREADS", "true").lower() != "false"
# Below this share of real words, a page's text layer is scanner rubbish.
GARBLED_SHARE = 0.85
CONVERT_TIMEOUT = 10 * 60

OFFICE_EXTENSIONS = {
    "application/vnd.openxmlformats-officedocument.presentationml.presentation": ".pptx",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document": ".docx",
    "application/vnd.ms-powerpoint": ".ppt",
    "application/msword": ".doc",
}

FILE_JOBS = {"extract_text", "ocr", "convert"}
RECORDING_JOBS = {"prepare_audio", "transcribe"}
AUDIO_TIMEOUT = 60 * 60
# Ten-minute pieces keep each transcription request well under API size limits.
SEGMENT_SECONDS = 600


class JobError(Exception):
    pass


@dataclass
class Context:
    api: Api
    keep_original_scans: bool = False
    ocr_jobs: int = 2
    keep_original_video: bool = False
    transcriber: Transcriber | None = None
    make_transcriber: Callable[[], Transcriber] | None = field(default=None, repr=False)
    # Crossref lookups need the internet; tests switch them off.
    online: bool = True

    def get_transcriber(self) -> Transcriber:
        if self.transcriber is None:
            if self.make_transcriber is None:
                raise JobError("no transcription backend configured")
            self.transcriber = self.make_transcriber()
        return self.transcriber


def _sha256(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _tail(text: str, lines: int = 12) -> str:
    return "\n".join((text or "").strip().splitlines()[-lines:])


def _live_file(ctx: Context, job: dict) -> dict | None:
    file = ctx.api.file(job["payload"]["file_id"])
    if file is None or file["deleted"]:
        return None
    return file


def ocr_languages(wanted: str = OCR_LANGUAGES) -> str:
    """The wanted languages that Tesseract has, as "eng+fra"; English if none."""
    try:
        listed = subprocess.run(["tesseract", "--list-langs"], capture_output=True, text=True, timeout=30).stdout
    except (OSError, subprocess.TimeoutExpired):
        return "eng"
    have = {line.strip() for line in listed.splitlines()[1:]}
    chosen = [lang for lang in wanted.split("+") if lang in have]
    return "+".join(chosen) or "eng"


_WORD = re.compile(r"^[^\W\d_][^\W\d_'\u2019-]*[^\W\d_]$|^[^\W\d_]{1}$")


def garbled(pages: list[str]) -> bool:
    """True when a text layer is mostly not words or lacks word spaces:
    the output of a poor scanner OCR, which leaves the page searchable in name only."""
    tokens = [t.strip(".,;:!?()[]\"'\u2018\u2019\u201c\u201d") for page in pages for t in page.split()]
    tokens = [t for t in tokens if t and not t.isdigit()]
    chars = sum(len(t) for t in tokens)
    if chars < 300 and len(tokens) < 30:
        return False
    mean_len = chars / max(1, len(tokens))
    long_tokens = sum(1 for t in tokens if len(t) > 20)
    if mean_len > 11.0 or (long_tokens / max(1, len(tokens)) > 0.08):
        return True
    words = sum(1 for t in tokens if _WORD.match(t) and any(ch in "aeiouyàâäéèêëîïôöûüAEIOUY" for ch in t))
    return words / max(1, len(tokens)) < GARBLED_SHARE


def split_spreads(source: str, dest: str, ignore_text: bool = False) -> int:
    """Splits two-page book spreads into single pages. Only pages with no
    text are touched, so nothing highlighted can move. A spread is a wide
    page with ink on both sides of an empty gutter near the middle.
    Returns how many pages were split; writes nothing if none were."""
    import pymupdf

    split = 0
    with pymupdf.open(source) as doc:
        cuts: list[float | None] = []
        for page in doc:
            rect = page.rect
            cut = None
            textless = ignore_text or len(page.get_text("text").strip()) < MIN_TEXT_CHARS
            if rect.width > rect.height * 1.2 and textless:
                pix = page.get_pixmap(dpi=40, colorspace=pymupdf.csGRAY)
                w, h = pix.width, pix.height
                data = pix.samples
                # How much ink each column holds.
                ink = [sum(255 - data[y * w + x] for y in range(0, h, 2)) for x in range(w)]
                band = range(int(w * 0.4), int(w * 0.6))
                gutter = min(band, key=lambda x: sum(ink[max(0, x - 1):x + 2]))
                left = sum(ink[int(w * 0.1):int(w * 0.4)]) / max(1, int(w * 0.3))
                right = sum(ink[int(w * 0.6):int(w * 0.9)]) / max(1, int(w * 0.3))
                middle = sum(ink[max(0, gutter - 1):gutter + 2]) / 3
                if left > 0 and right > 0 and middle < 0.25 * min(left, right):
                    cut = rect.x0 + rect.width * gutter / w
            cuts.append(cut)
        if not any(c is not None for c in cuts):
            return 0
        out = pymupdf.open()
        for index, (page, cut) in enumerate(zip(doc, cuts)):
            rect = page.rect
            if cut is None:
                out.insert_pdf(doc, from_page=index, to_page=index)
                continue
            for clip in (pymupdf.Rect(rect.x0, rect.y0, cut, rect.y1), pymupdf.Rect(cut, rect.y0, rect.x1, rect.y1)):
                half = out.new_page(width=clip.width, height=clip.height)
                half.show_pdf_page(half.rect, doc, index, clip=clip)
            split += 1
        out.save(dest, garbage=3, deflate=True)
    return split


def extract_text(ctx: Context, job: dict) -> None:
    import pymupdf

    file = _live_file(ctx, job)
    if file is None:
        return

    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "in.pdf")
        ctx.api.download(file["r2_key"], path)
        with pymupdf.open(path) as doc:
            pages = [page.get_text("text").replace("\x00", "") for page in doc]

    page_count = len(pages)
    sparse = sum(1 for text in pages if len(text.strip()) < MIN_TEXT_CHARS)
    # A rescan of a file this processor OCR'd before: the original scan has
    # gone, so its page images are read again. With highlights, only the text
    # is redone and the pages stay exactly as they are; without, the file is
    # rebuilt with the full treatment: spreads split, pages turned upright and
    # straightened, every language.
    payload = job["payload"]
    keep = bool(payload.get("keep_pages"))
    if payload.get("rescan") and file["r2_key"].endswith(".ocr.pdf"):
        ctx.api.needs_ocr(file["id"], page_count, job.get("priority"), mode="redo" if keep else "fresh")
        log.info("file %s rescanned: %s", file["id"], "text read again" if keep else "rebuilt from its pages")
        return
    if page_count and sparse / page_count > OCR_PAGE_SHARE and not job["payload"].get("after_ocr"):
        ctx.api.needs_ocr(file["id"], page_count, job.get("priority"))
        log.info("file %s needs OCR (%s of %s pages without text)", file["id"], sparse, page_count)
        return
    # Text that is mostly not words came from a poor scan: read it again.
    if page_count and not job["payload"].get("after_ocr") and garbled(pages):
        # Rebuilt from its pages when nothing is highlighted on it; otherwise
        # its text is read again with the pages left as they are.
        fresh = payload.get("rescan") and not keep
        ctx.api.needs_ocr(file["id"], page_count, job.get("priority"), redo=not fresh, mode="fresh" if fresh else "redo")
        log.info("file %s has a garbled text layer; reading it again", file["id"])
        return

    ctx.api.file_text(
        file["id"], page_count,
        [{"page": index, "body": text} for index, text in enumerate(pages) if text.strip()],
    )
    log.info("file %s ready with %s pages", file["id"], page_count)


def ocr_command(source: str, output: str, jobs: int, redo: bool | str, languages: str) -> list[str]:
    """The ocrmypdf command, in one of three modes.
    skip: only pages with no text are read, and turned and straightened, as
      they had no text and so no highlights; other pages are left as they were.
    redo: the text is read again everywhere; no page moves.
    fresh: the file is rebuilt from its page images, every page read, turned
      and straightened. Only for files with no highlights."""
    mode = redo if isinstance(redo, str) else ("redo" if redo else "skip")
    args = ["ocrmypdf", "--output-type", "pdf", "--optimize", "1", "--jobs", str(jobs),
            "-l", languages, "--tesseract-timeout", str(OCR_PAGE_TIMEOUT)]
    if mode == "redo":
        args += ["--redo-ocr"]
    else:
        args += ["--force-ocr" if mode == "fresh" else "--skip-text", "--rotate-pages", "--deskew"]
        # Cleaning helps Tesseract read the page; the page you see is unchanged.
        if shutil.which("unpaper"):
            args += ["--clean"]
    return args + [source, output]


def ocr(ctx: Context, job: dict) -> None:
    file = _live_file(ctx, job)
    if file is None:
        return

    mode = job["payload"].get("mode") or ("redo" if job["payload"].get("redo") else "skip")
    redo = mode == "redo"
    old_key = file["r2_key"]
    new_key = old_key.rsplit(".", 1)[0] + ".ocr.pdf"
    languages = ocr_languages()
    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "in.pdf")
        output = os.path.join(tmp, "out.pdf")
        ctx.api.download(old_key, source)
        spreads = 0
        if SPLIT_SPREADS and not redo:
            halves = os.path.join(tmp, "halves.pdf")
            spreads = split_spreads(source, halves, ignore_text=mode == "fresh")
            if spreads:
                source = halves
        result = subprocess.run(ocr_command(source, output, ctx.ocr_jobs, mode, languages),
                                capture_output=True, text=True, timeout=OCR_TIMEOUT)
        if result.returncode != 0 or not os.path.exists(output):
            raise JobError(f"ocrmypdf exited with {result.returncode}: {_tail(result.stderr)}")
        ctx.api.put_object(output, new_key, "application/pdf")
        size = os.path.getsize(output)

    ctx.api.replaced(file["id"], new_key, size, job.get("priority"))
    if not ctx.keep_original_scans and old_key != new_key:
        ctx.api.delete_unreferenced(old_key)
    log.info("file %s OCR done (%s%s, %s)", file["id"], {"redo": "read again", "fresh": "rebuilt"}.get(mode, "new text"),
             f", {spreads} spreads split" if spreads else "", languages)


def convert(ctx: Context, job: dict) -> None:
    file = _live_file(ctx, job)
    if file is None:
        return
    extension = OFFICE_EXTENSIONS.get(file["mime"])
    if extension is None:
        raise JobError(f"cannot convert {file['mime']}")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "source" + extension)
        ctx.api.download(file["r2_key"], source)
        profile = os.path.join(tmp, "profile")
        result = subprocess.run(
            ["soffice", f"-env:UserInstallation=file://{profile}", "--headless", "--norestore",
             "--convert-to", "pdf", "--outdir", tmp, source],
            capture_output=True, text=True, timeout=CONVERT_TIMEOUT,
            env={**os.environ, "HOME": tmp},
        )
        pdf = os.path.join(tmp, "source.pdf")
        if result.returncode != 0 or not os.path.exists(pdf):
            raise JobError(f"LibreOffice exited with {result.returncode}: {_tail(result.stderr)}")
        digest = _sha256(pdf)
        key = f"files/{digest}.pdf"
        ctx.api.put_object(pdf, key, "application/pdf")
        size = os.path.getsize(pdf)

    stem = (file.get("original_name") or "converted").rsplit(".", 1)[0]
    new_id = ctx.api.converted(file["id"], digest, key, size, stem + ".pdf")
    log.info("file %s converted to %s", file["id"], new_id)


# Recordings


def _run(args: list[str], timeout: int = AUDIO_TIMEOUT) -> subprocess.CompletedProcess:
    result = subprocess.run(args, capture_output=True, text=True, timeout=timeout)
    if result.returncode != 0:
        raise JobError(f"{args[0]} exited with {result.returncode}: {_tail(result.stderr)}")
    return result


def _duration(path: str) -> float:
    result = _run(["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], 120)
    try:
        return round(float(result.stdout.strip()), 2)
    except ValueError:
        return 0.0


def _chunk_index(key: str) -> int | None:
    match = re.search(r"/chunk-(\d+)\.[a-z0-9]+$", key)
    return int(match.group(1)) if match else None


def prepare_audio(ctx: Context, job: dict) -> None:
    recording_id = job["payload"]["recording_id"]
    info = ctx.api.recording(recording_id)
    recording = info["recording"]
    if recording["deleted"] or recording["status"] == "recording":
        return
    chunks: list[str] = info["chunks"]
    if chunks:
        indices = [_chunk_index(key) for key in chunks]
        if indices != list(range(len(chunks))):
            raise JobError(f"recording chunks must start at 0 without gaps (got {indices})")
    elif info.get("file") and info["file"]["id"] == f"{recording_id}:audio" and recording.get("turns"):
        ctx.api.recording_status(recording_id, "done")
        return
    elif not info.get("file"):
        raise JobError("recording has no audio yet")

    ctx.api.recording_status(recording_id, "processing")

    with tempfile.TemporaryDirectory() as tmp:
        source = os.path.join(tmp, "source")
        if chunks:
            # Chunks from one MediaRecorder session join into a single valid stream.
            extension = chunks[0].rsplit(".", 1)[-1]
            source += "." + extension
            with open(source, "wb") as out:
                for index, key in enumerate(chunks):
                    part = os.path.join(tmp, f"part{index}")
                    ctx.api.download(key, part)
                    with open(part, "rb") as handle:
                        out.write(handle.read())
                    os.remove(part)
            delete_source = False
        else:
            source += os.path.splitext(info["file"]["r2_key"])[1]
            ctx.api.download(info["file"]["r2_key"], source)
            delete_source = not ctx.keep_original_video

        output = os.path.join(tmp, "audio.ogg")
        # Mono speech at 24 kbps keeps an hour near 11 MB with clear voices.
        _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-i", source, "-vn", "-ac", "1",
              "-ar", "16000", "-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-bitexact", output])
        duration = _duration(output)
        sha256 = _sha256(output)
        key = f"recordings/{recording_id}/audio.ogg"
        ctx.api.put_object(output, f"files/{key}", "audio/ogg")
        size = os.path.getsize(output)

    ctx.api.recording_audio(recording_id, f"files/{key}", size, duration, "audio/ogg", delete_source,
                            sha256=sha256, chunks=chunks)
    log.info("recording %s audio ready, %.0f seconds", recording_id, duration)


def _cut_points(path: str, length: float, target: float = SEGMENT_SECONDS) -> list[float]:
    """Where to split a long recording: close to every ten minutes, but in a
    pause, so no sentence is cut in two."""
    result = _run(["ffmpeg", "-hide_banner", "-nostats", "-i", path, "-af", "silencedetect=noise=-35dB:d=0.4", "-f", "null", "-"], 1800)
    pauses = [float(m) for m in re.findall(r"silence_end: ([\d.]+)", result.stderr or "")]
    cuts, at = [], target
    while at < length - 30:
        near = [p for p in pauses if abs(p - at) <= 45]
        cut = min(near, key=lambda p: abs(p - at)) if near else at
        cuts.append(round(cut, 2))
        at = cut + target
    return cuts


def _piece_key(recording_id: str, start: float, end: float) -> str:
    return f"files/recordings/{recording_id}/pieces/{start:.2f}-{end:.2f}.txt"


def transcribe(ctx: Context, job: dict) -> None:
    """Transcribes a recording piece by piece. Each finished piece is kept,
    so a retry after a failure only pays for the pieces still to do."""
    recording_id = job["payload"]["recording_id"]
    info = ctx.api.recording(recording_id)
    recording = info["recording"]
    if recording["deleted"] or recording["status"] == "recording" or not info.get("file"):
        return
    if recording["status"] == "done" and recording.get("turns"):
        return
    context = info.get("context") or {}
    prompt, keywords = context.get("prompt", ""), context.get("keywords", [])

    with tempfile.TemporaryDirectory() as tmp:
        audio = os.path.join(tmp, "audio.ogg")
        ctx.api.download(info["file"]["r2_key"], audio)
        length = _duration(audio)
        # The cuts depend only on the audio, so a retry finds the same pieces.
        bounds = [0.0, *_cut_points(audio, length), length or 10 ** 6]
        texts: list[str] = []
        keys: list[str] = []
        reused = 0
        for n, (start, end) in enumerate(zip(bounds, bounds[1:])):
            key = _piece_key(recording_id, start, end)
            keys.append(key)
            kept = ctx.api.read_text(key)
            if kept is not None:
                reused += 1
                if kept.strip():
                    texts.append(kept.strip())
                continue
            # MP3 is accepted by every model; mono at 64 kbps keeps ten
            # minutes well under the 25 MB limit.
            piece = os.path.join(tmp, f"piece{n:03d}.mp3")
            _run(["ffmpeg", "-y", "-hide_banner", "-loglevel", "error", "-ss", str(start), "-to", str(end), "-i", audio,
                  "-ac", "1", "-ar", "16000", "-c:a", "libmp3lame", "-b:a", "64k", piece])
            # Each piece is told what the recording is, and how the last one ended.
            tail = " ".join(" ".join(texts).split()[-60:])
            hint = f"{prompt} {tail}".strip()
            text = ctx.get_transcriber().transcribe(piece, hint[-1500:], keywords).strip()
            ctx.api.put_text(key, text)
            if text:
                texts.append(text)

    # Pieces join with a space: a cut falls in a pause, not at a paragraph.
    ctx.api.save_transcript(recording_id, " ".join(texts))
    for key in keys:
        ctx.api.delete_object(key)
    log.info("recording %s transcribed: %s words, %s of %s pieces reused",
             recording_id, len(" ".join(texts).split()), reused, len(keys))


def identify(ctx: Context, job: dict) -> None:
    """Works out a reading's citation from its first and last pages."""
    import pymupdf

    file = _live_file(ctx, job)
    if file is None or file["mime"] != "application/pdf":
        return
    with tempfile.TemporaryDirectory() as tmp:
        path = os.path.join(tmp, "in.pdf")
        ctx.api.download(file["r2_key"], path)
        with pymupdf.open(path) as doc:
            meta = doc.metadata or {}
            n = len(doc)
            page_indices = list(range(min(3, n)))
            for idx in [n - 2, n - 1]:
                if idx >= 0 and idx not in page_indices:
                    page_indices.append(idx)
            text = "\n".join(doc[i].get_text("text") for i in page_indices)
            lines = finder.first_page_lines(doc)
            citation, via = finder.identify(text, meta, lines, ctx.online, doc=doc)
    if citation:
        ctx.api.identified(file["id"], citation, via)
    log.info("file %s identified %s", file["id"], f"by {via}" if via else "as unknown")


HANDLERS: dict[str, Callable[[Context, dict], None]] = {
    "extract_text": extract_text,
    "ocr": ocr,
    "convert": convert,
    "prepare_audio": prepare_audio,
    "transcribe": transcribe,
    "identify": identify,
}
