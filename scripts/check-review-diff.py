"""Checks that a review bundle (git status plus git diff) is complete before it is reviewed.

Usage:
    python3 scripts/check-review-diff.py <bundle.patch>
    python3 scripts/check-review-diff.py <dir>/bundle-part-*.patch    (every part, together)

A reviewer can only gate what it can see. This fails when a bundle was cut short or
leaves out changes, so a commit is never approved on a partial view:
  1. a truncation marker appears on a line of its own, where the transport puts it
     (matching it anywhere would flag any bundle that carries this file's own source);
  2. a hunk ends before the line counts in its @@ header are met;
  3. a path in the status has no diff section (untracked files too: make-bundle.py
     includes them, or add them with `git add -N <path>` before `git diff`);
  4. for parts written by make-bundle.py: a part is missing, the parts disagree about
     the status, a part's sections do not match its COVERS list, or some hunks of a
     file appear in no part.
Exits 0 when complete, 1 with one line per problem otherwise.
"""
import re, sys

MARKER = re.compile(r"^\[\.\.\.\s*diff" + r"\s+truncated\s*\.\.\.\]\s*$", re.M | re.I)
PART = re.compile(r"^### REVIEW BUNDLE PART (\d+) OF (\d+)\s*$", re.M)

def block(text, heading, fence=""):
    m = re.search(r"### " + re.escape(heading) + r":\s*```" + fence + r"\s*\n(.*?)```", text, re.S)
    return m.group(1) if m else None

def unquote(path):
    if len(path) >= 2 and path[0] == path[-1] == '"':
        return bytes(path[1:-1], "utf-8").decode("unicode_escape").encode("latin-1").decode("utf-8", "replace")
    return path

def status_entries(text):
    body = block(text, "GIT STATUS")
    if body is None:
        return None
    entries = []
    for line in body.splitlines():
        m = re.match(r"^\s*([MADRCUT?]{1,2})\s+(.+?)\s*$", line)
        if m:
            entries.append((m.group(1), unquote(m.group(2).split(" -> ")[-1])))
    return entries

def section_path(section):
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

def sections_of(text):
    """{path: number of hunks} for the diff sections in a bundle, and hunk problems."""
    problems, found = [], {}
    body_start = text.find("### GIT RECENT CHANGES (DIFF):")
    diff = text[body_start:] if body_start >= 0 else text
    for section in re.split(r"(?m)^(?=diff --git )", diff):
        if section.startswith("diff --git "):
            path = section_path(section)
            found[path] = found.get(path, 0) + len(re.findall(r"(?m)^@@ ", section))
    lines = text.splitlines()
    i = 0
    while i < len(lines):
        m = re.match(r"^@@ -\d+(?:,(\d+))? \+\d+(?:,(\d+))? @@", lines[i])
        if not m:
            i += 1
            continue
        old_left = int(m.group(1) if m.group(1) is not None else 1)
        new_left = int(m.group(2) if m.group(2) is not None else 1)
        header_line = i + 1
        i += 1
        while (old_left > 0 or new_left > 0) and i < len(lines):
            l = lines[i]
            if l.startswith("\\"):
                i += 1
                continue
            if l.startswith(" ") or l == "":
                old_left -= 1; new_left -= 1
            elif l.startswith("-"):
                old_left -= 1
            elif l.startswith("+"):
                new_left -= 1
            else:
                break
            i += 1
        if old_left > 0 or new_left > 0:
            problems.append(f"the hunk at line {header_line} ends {old_left} old and {new_left} new lines short")
    return found, problems

def check_single(text, name="the bundle"):
    problems = []
    if MARKER.search(text):
        problems.append(f"{name} contains a truncation marker, so the diff was cut short")
    entries = status_entries(text)
    if entries is None:
        return problems + [f"{name} has no git status block"]
    found, hunk_problems = sections_of(text)
    problems += [f"{name}: {p}" for p in hunk_problems]
    for code, path in entries:
        if code == "??":
            covered = path in found or (path.endswith("/") and any(s.startswith(path) for s in found))
            if not covered:
                problems.append(f"untracked {path} has no diff, so it was not reviewed")
        elif path not in found:
            problems.append(f"{code} {path} is in the status but has no diff section")
    return problems

def check_parts(named_texts):
    problems, totals, seen_hunks, numbers, counts, statuses = [], {}, {}, set(), set(), set()
    for name, text in named_texts:
        m = PART.search(text)
        if not m:
            problems.append(f"{name} is not a numbered part; pass a single bundle on its own")
            continue
        number, count = int(m.group(1)), int(m.group(2))
        if number in numbers:
            problems.append(f"part {number} was given twice")
        numbers.add(number)
        counts.add(count)
        if MARKER.search(text):
            problems.append(f"{name} contains a truncation marker, so it was cut short")
        status = block(text, "GIT STATUS")
        if status is None:
            problems.append(f"{name} has no git status block")
        else:
            statuses.add(status.strip())
        covers = block(text, "COVERS")
        if covers is None:
            problems.append(f"{name} has no COVERS list")
            continue
        found, hunk_problems = sections_of(text)
        problems += [f"{name}: {p}" for p in hunk_problems]
        declared = {}
        for line in covers.splitlines():
            if not line.strip():
                continue
            path, span = line.rsplit(" ", 1)
            sm = re.fullmatch(r"(\d+)-(\d+)/(\d+)", span)
            if not sm:
                problems.append(f"{name}: unreadable COVERS line {line!r}")
                continue
            first, last, total = map(int, sm.groups())
            declared[path] = declared.get(path, 0) + (last - first + 1 if total else 0)
            totals.setdefault(path, total)
            if totals[path] != total:
                problems.append(f"{path}: parts disagree on its number of hunks")
            seen_hunks.setdefault(path, set()).update(range(first, last + 1) if total else [])
        for path, n in declared.items():
            if path not in found:
                problems.append(f"{name} lists {path} but has no diff section for it")
            elif found[path] != n:
                problems.append(f"{name} lists {n} hunks of {path} but holds {found[path]}")
        for path in found:
            if path not in declared:
                problems.append(f"{name} holds {path} but does not list it")
    if len(counts) > 1:
        problems.append(f"the parts disagree on how many parts there are: {sorted(counts)}")
    if counts:
        expected = set(range(1, max(counts) + 1))
        for missing in sorted(expected - numbers):
            problems.append(f"part {missing} of {max(counts)} is missing")
    if len(statuses) > 1:
        problems.append("the parts carry different git status blocks, so they come from different states")
    for path, total in totals.items():
        lost = set(range(1, total + 1)) - seen_hunks.get(path, set())
        if lost:
            problems.append(f"{path}: hunks {sorted(lost)} are in no part")
    if statuses:
        fake = "### GIT STATUS:\n```\n" + next(iter(statuses)) + "\n```\n"
        for code, path in status_entries(fake) or []:
            if path not in totals:
                problems.append(f"{code} {path} is in the status but in no part")
    return problems

def check(texts):
    """texts: list of (name, text). One unnumbered bundle, or every part of a split bundle."""
    if len(texts) == 1 and not PART.search(texts[0][1]):
        return check_single(texts[0][1])
    return check_parts(texts)

if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit("Usage: python3 scripts/check-review-diff.py <bundle.patch> [more parts...]")
    named = [(p, open(p, encoding="utf-8", errors="replace").read()) for p in sys.argv[1:]]
    found = check(named)
    for p in found:
        print("INCOMPLETE  " + p)
    print("Review bundle is complete." if not found else f"Review bundle is incomplete: {len(found)} problems.")
    sys.exit(1 if found else 0)
