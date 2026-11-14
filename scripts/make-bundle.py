"""Writes the working tree's changes as review bundles small enough to arrive whole.

Usage, from the repository root:
    python3 scripts/make-bundle.py [--out DIR] [--max-chars 50000] [--base HEAD]

The review transport cuts anything past about 61,000 characters, so one bundle cannot
carry a large commit. This writes as many parts as the changes need, each under
--max-chars, as bundle-part-<i>-of-<n>.patch in --out (by default ../review-bundle,
outside the repository, so the bundle never lists itself as a change).

Every part repeats the full git status, says which part it is, and lists what it
covers. A file whose diff is too long for one part is split between hunks, and each
piece repeats the file's diff header, so every part is a valid patch on its own.
Untracked files are included as new-file diffs, read-only: the index is not touched.

Check the result with:
    python3 scripts/check-review-diff.py <out>/bundle-part-*.patch
"""
import argparse, os, re, subprocess, sys

def git(args, ok=(0,)):
    r = subprocess.run(["git", *args], capture_output=True, text=True, encoding="utf-8", errors="replace")
    if r.returncode not in ok:
        sys.exit(f"git {' '.join(args)} failed: {r.stderr.strip() or r.returncode}")
    return r.stdout

def status_entries():
    """(code, path) for every change, from porcelain output, so odd paths stay exact."""
    raw = git(["status", "--porcelain=v1", "-z", "--untracked-files=all"])
    items = raw.split("\0")
    out, i = [], 0
    while i < len(items):
        rec = items[i]
        i += 1
        if not rec:
            continue
        code, path = rec[:2], rec[3:]
        if code[0] in "RC":
            old = items[i]
            i += 1
            out.append((code, f"{old} -> {path}", path))
        else:
            out.append((code, path, path))
    return out

def section_path(section):
    """The path a diff section changes, read from its +++ or --- line, else its header."""
    lines = section.splitlines()
    for prefix in ("+++ b/", "--- a/"):
        for line in lines:
            if line.startswith("@@"):
                break
            if line.startswith(prefix):
                return line[len(prefix):].rstrip("\t")
    rest = lines[0][len("diff --git "):]
    # A rename or copy names its destination outright; use that before guessing.
    for line in lines:
        if line.startswith("@@"):
            break
        for prefix in ("rename to ", "copy to "):
            if line.startswith(prefix):
                return line[len(prefix):]
    # Otherwise the header is "a/<path> b/<path>" with the same path twice.
    length = (len(rest) - 5) // 2
    if rest.startswith("a/") and rest[2 + length:2 + length + 3] == " b/" and rest[2:2 + length] == rest[5 + length:]:
        return rest[2:2 + length]
    return rest.split(" b/", 1)[-1]

def split_section(section):
    """Header text and the list of hunk texts of one file's diff."""
    m = re.search(r"(?m)^@@ ", section)
    if not m:
        return section, []
    header, body = section[:m.start()], section[m.start():]
    hunks = re.split(r"(?m)^(?=@@ )", body)
    return header, [h for h in hunks if h]

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=None)
    ap.add_argument("--max-chars", type=int, default=50000)
    ap.add_argument("--base", default="HEAD")
    args = ap.parse_args()

    root = git(["rev-parse", "--show-toplevel"]).strip()
    os.chdir(root)
    out_dir = os.path.abspath(args.out or os.path.join(root, os.pardir, "review-bundle"))
    inside = os.path.commonpath([out_dir, root]) == root
    out_rel = os.path.relpath(out_dir, root).replace(os.sep, "/") + "/" if inside else None

    entries = [e for e in status_entries() if not (out_rel and e[2].startswith(out_rel))]
    if not entries:
        sys.exit("There are no changes to bundle.")
    status_text = "\n".join(f"{code} {shown}" for code, shown, _ in entries)

    diff = git(["diff", args.base, "--no-color", "--no-ext-diff", "-M"])
    for code, _, path in entries:
        if code == "??":
            diff += git(["diff", "--no-index", "--no-color", "--", "/dev/null", path], ok=(0, 1))
    sections = [s for s in re.split(r"(?m)^(?=diff --git )", diff) if s.startswith("diff --git ")]

    def wrap(i, n, covers, body):
        return (
            f"### REVIEW BUNDLE PART {i} OF {n}\n\n"
            f"### GIT STATUS:\n```\n{status_text}\n```\n\n"
            f"### COVERS:\n```\n" + "\n".join(covers) + "\n```\n\n"
            f"### GIT RECENT CHANGES (DIFF):\n```diff\n{body}```\n"
        )

    # Room for the diff in each part, after the status, covers list and fences.
    overhead = len(wrap(99, 99, ["x" * 120] * 40, ""))
    budget = args.max_chars - overhead
    if budget < 4000:
        sys.exit(f"--max-chars {args.max_chars} leaves only {budget} characters for the diff; raise it.")

    chunks = []  # (path, text, first, last, total)
    for section in sections:
        path = section_path(section)
        header, hunks = split_section(section)
        total = len(hunks)
        if len(section) <= budget or total == 0:
            if len(section) > budget:
                sys.exit(f"{path}: its diff has no hunks to split at and is {len(section)} characters; raise --max-chars.")
            chunks.append((path, section, 1 if total else 0, total, total))
            continue
        piece, first = [], 1
        for k, hunk in enumerate(hunks, start=1):
            if len(header) + len(hunk) > budget:
                sys.exit(f"{path}: hunk {k} alone is {len(header) + len(hunk)} characters; raise --max-chars or split the change.")
            if piece and len(header) + sum(map(len, piece)) + len(hunk) > budget:
                chunks.append((path, header + "".join(piece), first, k - 1, total))
                piece, first = [], k
            piece.append(hunk)
        chunks.append((path, header + "".join(piece), first, total, total))

    parts, current, size = [], [], 0
    for chunk in chunks:
        if current and size + len(chunk[1]) > budget:
            parts.append(current)
            current, size = [], 0
        current.append(chunk)
        size += len(chunk[1])
    if current:
        parts.append(current)

    os.makedirs(out_dir, exist_ok=True)
    for old in os.listdir(out_dir):
        if re.fullmatch(r"bundle-part-\d+-of-\d+\.patch", old):
            os.remove(os.path.join(out_dir, old))
    n = len(parts)
    for i, part in enumerate(parts, start=1):
        covers = [f"{p} {a}-{b}/{t}" for p, _, a, b, t in part]
        text = wrap(i, n, covers, "".join(c[1] for c in part))
        if len(text) > args.max_chars:
            sys.exit(f"Part {i} came to {len(text)} characters, over --max-chars; raise it slightly.")
        name = os.path.join(out_dir, f"bundle-part-{i}-of-{n}.patch")
        tmp = name + ".tmp"
        with open(tmp, "w", encoding="utf-8") as fh:
            fh.write(text)
        os.replace(tmp, name)
        print(f"{name}: {len(text)} characters, {len(part)} file pieces")
    print(f"Wrote {n} part(s) to {out_dir}. Check them with: python3 scripts/check-review-diff.py {out_dir}/bundle-part-*.patch")

if __name__ == "__main__":
    main()
