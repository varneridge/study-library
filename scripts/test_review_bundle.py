"""Tests for make-bundle.py and check-review-diff.py, against throwaway git repositories.

Run from the repository root:
    python3 -m unittest discover -s scripts -p "test_review_bundle.py" -v
"""
import glob, os, shutil, subprocess, sys, tempfile, unittest

HERE = os.path.dirname(os.path.abspath(__file__))
MAKE = os.path.join(HERE, "make-bundle.py")
CHECK = os.path.join(HERE, "check-review-diff.py")
MAX = 12000

def run(args, cwd):
    return subprocess.run(args, cwd=cwd, capture_output=True, text=True, encoding="utf-8")

def git(cwd, *args):
    r = run(["git", "-c", "user.email=t@t", "-c", "user.name=t", *args], cwd)
    assert r.returncode == 0, r.stderr
    return r.stdout

class ReviewBundleTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp()
        self.repo = os.path.join(self.tmp, "repo")
        self.out = os.path.join(self.tmp, "bundle")
        os.makedirs(self.repo)
        git(self.repo, "init", "-q")
        line = "The quick brown fox jumps over the lazy dog while the archive keeps its place, line {}.\n"
        with open(os.path.join(self.repo, "big.txt"), "w") as fh:
            fh.writelines(line.format(i) for i in range(600))
        for name in ("gone.txt", "old-name.txt"):
            with open(os.path.join(self.repo, name), "w") as fh:
                fh.write(f"{name}\nkept as it was\n")
        git(self.repo, "add", "-A")
        git(self.repo, "commit", "-qm", "base")
        # Sixty separate hunks in one file, so it has to be split between parts.
        with open(os.path.join(self.repo, "big.txt"), "w") as fh:
            fh.writelines((line.format(i) if i % 10 else line.format(i).upper()) for i in range(600))
        os.remove(os.path.join(self.repo, "gone.txt"))
        git(self.repo, "mv", "old-name.txt", "new-name.txt")
        os.makedirs(os.path.join(self.repo, "d"))
        with open(os.path.join(self.repo, "d", "new file.txt"), "w") as fh:
            fh.write("an untracked file with a space in its name\n")

    def tearDown(self):
        shutil.rmtree(self.tmp)

    def make(self):
        r = run([sys.executable, MAKE, "--out", self.out, "--max-chars", str(MAX)], self.repo)
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        return sorted(glob.glob(os.path.join(self.out, "bundle-part-*.patch")))

    def check(self, paths):
        return run([sys.executable, CHECK, *paths], self.repo)

    def test_parts_are_small_and_complete_together(self):
        parts = self.make()
        self.assertGreater(len(parts), 1, "the big file should need more than one part")
        for p in parts:
            with open(p, encoding="utf-8") as fh:
                self.assertLessEqual(len(fh.read()), MAX, p)
        r = self.check(parts)
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertIn("Review bundle is complete.", r.stdout)

    def test_every_change_is_carried(self):
        text = ""
        for p in self.make():
            with open(p, encoding="utf-8") as fh:
                text += fh.read()
        for path in ("big.txt", "gone.txt", "d/new file.txt"):
            self.assertIn(f"diff --git a/{path} b/{path}", text)
        self.assertIn("rename to new-name.txt", text)
        self.assertIn("new-name.txt 0-0/0", text)
        self.assertIn("+an untracked file with a space in its name", text)

    def test_a_missing_part_fails(self):
        parts = self.make()
        r = self.check(parts[:-1])
        self.assertEqual(r.returncode, 1)
        self.assertIn(f"part {len(parts)} of {len(parts)} is missing", r.stdout)

    def test_a_truncated_part_fails(self):
        parts = self.make()
        with open(parts[0], encoding="utf-8") as fh:
            text = fh.read()
        with open(parts[0], "w", encoding="utf-8") as fh:
            fh.write(text[: len(text) // 2] + "\n\n[...diff truncated...]\n```")
        r = self.check(parts)
        self.assertEqual(r.returncode, 1)
        self.assertIn("truncation marker", r.stdout)

    def test_a_part_cut_mid_hunk_without_a_marker_fails(self):
        parts = self.make()
        with open(parts[0], encoding="utf-8") as fh:
            text = fh.read()
        cut = text.rindex("@@ ") + 120
        with open(parts[0], "w", encoding="utf-8") as fh:
            fh.write(text[:cut] + "\n```\n")
        r = self.check(parts)
        self.assertEqual(r.returncode, 1, r.stdout)

    def test_parts_from_different_states_fail(self):
        first = self.make()
        kept = os.path.join(self.tmp, "kept-part-1.patch")
        shutil.copy(first[0], kept)
        with open(os.path.join(self.repo, "late.txt"), "w") as fh:
            fh.write("changed after the first bundle\n")
        second = self.make()
        r = self.check([kept, *second[1:]])
        self.assertEqual(r.returncode, 1)
        self.assertIn("different git status blocks", r.stdout)

    def test_the_bundle_never_lists_itself(self):
        inside = os.path.join(self.repo, "review-out")
        r = run([sys.executable, MAKE, "--out", inside, "--max-chars", str(MAX)], self.repo)
        self.assertEqual(r.returncode, 0, r.stderr)
        with open(sorted(glob.glob(os.path.join(inside, "*.patch")))[0], encoding="utf-8") as fh:
            text = fh.read()
        self.assertNotIn("review-out/", text)

    def test_a_bundle_that_carries_the_checker_itself_is_not_flagged(self):
        # The checker's own source mentions the marker; only a marker line of its own counts.
        shutil.copy(CHECK, os.path.join(self.repo, "check-review-diff.py"))
        made = run([sys.executable, MAKE, "--out", self.out, "--max-chars", "40000"], self.repo)
        self.assertEqual(made.returncode, 0, made.stdout + made.stderr)
        parts = sorted(glob.glob(os.path.join(self.out, "bundle-part-*.patch")))
        r = self.check(parts)
        self.assertEqual(r.returncode, 0, r.stdout)

    def test_a_single_truncated_bundle_still_fails(self):
        single = os.path.join(self.tmp, "single.patch")
        with open(single, "w", encoding="utf-8") as fh:
            fh.write("### GIT STATUS:\n```\n M a.txt\n M b.txt\n```\n\n### GIT RECENT CHANGES (DIFF):\n```diff\n"
                     "diff --git a/a.txt b/a.txt\n--- a/a.txt\n+++ b/a.txt\n@@ -1,2 +1,3 @@\n one\n+two\n"
                     "\n[...diff truncated...]\n```\n")
        r = self.check([single])
        self.assertEqual(r.returncode, 1)
        self.assertIn("truncation marker", r.stdout)
        self.assertIn("M b.txt is in the status but has no diff section", r.stdout)

if __name__ == "__main__":
    unittest.main()
```
