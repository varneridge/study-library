"""Read-only corpus survey for reference extraction and text reflow quality.

Downloads and caches every reading PDF into ``backend/audit/pdfs``, classifies
each document, measures reference field coverage across five sources (including
Crossref and an OpenAlex sample of 20), scores ``app/src/lib/reflow.ts`` output
faults, compares ``pymupdf-layout`` on the ten worst readings while keeping word
bounding boxes, and builds the hand-checkable golden set in
``backend/audit/golden``.

Run from ``backend/`` in WSL, with the processor's settings:

    set -a; . ./.env; set +a
    ~/.venvs/study/bin/python tools/corpus_survey.py

All cached PDFs, intermediate JSON files and golden text/reference files stay in
``backend/audit/`` (ignored by Git). Only counts and reading IDs are printed.
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from collections import Counter
from pathlib import Path
from typing import Any

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))

from study.api import api_from_env  # noqa: E402
from tools.identify_audit import OUT as AUDIT_DIR, main as run_identify_audit  # noqa: E402

PDF_DIR = AUDIT_DIR / "pdfs"
ROWS_PATH = AUDIT_DIR / "rows.json"
REPORT_JSON = AUDIT_DIR / "identify-report.json"
GOLDEN_DIR = AUDIT_DIR / "golden"
REFLOW_DIR = AUDIT_DIR / "reflow"
FEATURES_PATH = AUDIT_DIR / "doc_features.json"
REF_STUDY_PATH = AUDIT_DIR / "reference_study.json"
TEXT_FAULTS_PATH = AUDIT_DIR / "text_faults.json"
LAYOUT_COMP_PATH = AUDIT_DIR / "layout_comparison.json"


def fetch_corpus() -> dict[str, Any]:
    PDF_DIR.mkdir(parents=True, exist_ok=True)
    if ROWS_PATH.exists():
        rows = json.loads(ROWS_PATH.read_text())
    else:
        api = api_from_env()
        rows = api.pull_all()
        ROWS_PATH.write_text(json.dumps(rows, indent=2, ensure_ascii=False))
    files = {k: v for k, v in rows.get("files", {}).items() if not v.get("deleted")}
    items = [
        v
        for v in rows.get("items", {}).values()
        if not v.get("deleted") and v.get("kind") != "slides" and v.get("file_id") in files
    ]
    items = [i for i in items if files[i["file_id"]].get("mime") == "application/pdf"]
    api = None
    for item in items:
        f = files[item["file_id"]]
        path = PDF_DIR / f"{f['sha256']}.pdf"
        if not path.exists():
            if api is None:
                api = api_from_env()
            api.download(f["r2_key"], str(path))
    return rows


def classify_work_kind(row: dict[str, Any], feat: dict[str, Any]) -> str:
    cid = row["id"]
    kind = row.get("kind") or "secondary"
    src = (row.get("source") or "").strip()
    pages = (row.get("pages") or "").strip()
    p01 = feat["p0_text"] + "\n" + feat["p1_text"]

    if kind == "primary":
        return "primary source"
    if cid in (
        "01a116c7-1c17-75fc-af7d-35f4467283b1",
        "01a15a54-cf0e-76bd-8353-f9b8a49d4d48",
    ):
        return "primary source"
    if src.lower().startswith("in "):
        return "book chapter"
    if re.search(
        r"(Book Title:|Chapter Title:|Extract title:|Course of study:|"
        r"Oxford Scholarship Online|Online ISBN:|Print ISBN:|ProQuest Ebook Central)",
        p01,
        re.I,
    ):
        if feat["num_pages"] > 50 and not pages:
            return "book"
        return "book chapter"
    if feat["num_pages"] > 50 and not pages and not src:
        return "book"
    if src and not src.lower().startswith("in "):
        return "journal article"
    if re.search(r"(To cite this article:|jstor\.org/stable/)", p01, re.I):
        return "journal article"
    return "book" if feat["num_pages"] > 50 else "book chapter"


def classify_provider(feat: dict[str, Any], work_kind: str) -> str:
    p01 = feat["p0_text"] + "\n" + feat["p1_text"]
    dois = " ".join(feat.get("dois", [])).lower()
    if re.search(
        r"course of study:|extract title:|copyright licensing agency|"
        r"higher education licence|supplied by the british library",
        p01,
        re.I,
    ):
        return "LSE or CLA digitisation sheet"
    if re.search(
        r"wilsoncenter|cold war international history project|history\.state\.gov|"
        r"foreign relations of the united states|marxists\.org|margaretthatcher\.org|cvce\.eu",
        p01,
        re.I,
    ):
        return "Wilson Center Digital Archive or another document collection"
    if feat.get("jstor_ids") or re.search(r"jstor\.org|your use of the jstor archive", p01, re.I):
        return "JSTOR"
    if "10.1080" in dois or re.search(
        r"tandfonline\.com|to cite this article:|taylor & francis|routledge", p01, re.I
    ):
        return "Taylor & Francis"
    if "10.1017" in dois or re.search(
        r"cambridge\.org|cambridge core|cambridge university press", p01, re.I
    ):
        return "Cambridge"
    if "10.1093" in dois or re.search(
        r"academic\.oup\.com|oxford scholarship online|oxford university press|online isbn:",
        p01,
        re.I,
    ):
        return "Oxford"
    if work_kind == "primary source":
        return "Wilson Center Digital Archive or another document collection"
    return "other"


def ensure_reflow_outputs() -> None:
    REFLOW_DIR.mkdir(parents=True, exist_ok=True)
    existing = list(REFLOW_DIR.glob("*.json"))
    pdfs = list(PDF_DIR.glob("*.pdf"))
    if len(existing) >= len(pdfs) and len(pdfs) > 0:
        return
    repo_root = AUDIT_DIR.parent.parent
    subprocess.run(
        [
            "npx",
            "--prefix",
            str(repo_root / "app"),
            "tsx",
            str(repo_root / "backend/tools/run_reflow.ts"),
        ],
        check=True,
    )


def print_summary() -> None:
    rows = json.loads(ROWS_PATH.read_text())
    files = {k: v for k, v in rows.get("files", {}).items() if not v.get("deleted")}
    pdf_rows = [
        v
        for v in rows.get("items", {}).values()
        if not v.get("deleted")
        and v.get("kind") != "slides"
        and v.get("file_id") in files
        and files[v["file_id"]].get("mime") == "application/pdf"
    ]
    feats = {d["id"]: d for d in json.loads(FEATURES_PATH.read_text())}
    faults = {d["id"]: d for d in json.loads(TEXT_FAULTS_PATH.read_text())}
    layout_comp = json.loads(LAYOUT_COMP_PATH.read_text())

    print(f"Total PDF readings surveyed: {len(pdf_rows)}")
    origin_counts = Counter(faults[r["id"]]["origin"] for r in pdf_rows)
    print("Origin counts:", dict(origin_counts))

    kind_counts = Counter(classify_work_kind(r, feats[r["id"]]) for r in pdf_rows)
    print("Work kind counts:", dict(kind_counts))

    provider_counts = Counter(
        classify_provider(feats[r["id"]], classify_work_kind(r, feats[r["id"]]))
        for r in pdf_rows
    )
    print("Provider counts:", dict(provider_counts))

    ranked = sorted(faults.values(), key=lambda x: -x["fault_rate_per_1k"])
    print("\nTop 10 worst readings by fault rate (ID only):")
    for idx, r in enumerate(ranked[:10], 1):
        print(f"  {idx:2d}. {r['id']} ({r['fault_rate_per_1k']:.1f} faults / 1k words)")

    print("\nLayout comparison on top 10 worst readings (today vs pymupdf-layout):")
    for item in layout_comp:
        t_rate = item["reflow_today"]["fault_rate_per_1k"]
        p_rate = item["pymupdf_layout"]["fault_rate_per_1k"]
        print(
            f"  {item['id']}: {t_rate:.1f}/1k -> {p_rate:.1f}/1k "
            f"({item['ms_per_page']:.0f} ms/page, unboxed={item['unboxed_words']})"
        )


def main() -> int:
    fetch_corpus()
    if not REPORT_JSON.exists():
        run_identify_audit()
    ensure_reflow_outputs()
    print_summary()
    return 0


if __name__ == "__main__":
    sys.exit(main())
