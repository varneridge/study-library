"""Import one Zotero collection into an existing Study Library module.

Dry run, which changes nothing:
    python -m study.zotero --zotero-dir ~/Zotero --collection HY335 --module HY335

Apply it, with STUDY_URL and the Access service token set in the environment:
    python -m study.zotero ... --apply
"""

from __future__ import annotations

import argparse
import sys

from ..api import api_from_env
from .importer import Importer, build_plan, format_plan
from .reader import ZoteroLibrary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="python -m study.zotero", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--zotero-dir", required=True, help="Zotero data folder, which holds zotero.sqlite")
    parser.add_argument("--collection", required=True, help="Zotero collection name")
    parser.add_argument("--collection-key", help="Collection key, if several share the same name")
    parser.add_argument("--module", required=True, help="Study Library module code, such as HY335")
    parser.add_argument("--apply", action="store_true", help="Write to Study Library")
    args = parser.parse_args(argv)

    with ZoteroLibrary(args.zotero_dir) as library:
        collections = library.collections_named(args.collection)
        if args.collection_key:
            collections = [c for c in collections if c["key"] == args.collection_key]
        if not collections:
            print(f"No collection called {args.collection!r}.", file=sys.stderr)
            return 1
        if len(collections) > 1:
            keys = ", ".join(c["key"] for c in collections)
            print(f"Several collections share that name. Pass --collection-key with one of: {keys}",
                  file=sys.stderr)
            return 1

        entries = library.collection_entries(collections[0]["collectionID"])
        plan = build_plan(entries)

    print(format_plan(plan))
    print()
    print(f"{len(plan.readings)} readings, {len(plan.session_notes)} week notes, "
          f"{len(plan.skipped)} skipped.")

    if not args.apply:
        print("Dry run. Nothing was written. Add --apply to import.")
        return 0

    importer = Importer(api_from_env(), args.module)
    summary = importer.apply(plan)

    print(f"Uploaded {summary.files_uploaded} files and reused {summary.files_reused}.")
    print(f"Added {summary.items_added} readings and kept {summary.items_kept} already imported.")
    print(f"Added {summary.highlights_added} highlights and {summary.notes_added} notes.")
    print(f"Set {summary.week_titles_set} week titles.")
    for warning in summary.warnings:
        print(f"Warning: {warning}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
