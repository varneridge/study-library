# Study Library Windows installer: design

Status: implemented in `packaging/windows/`, unit tested on Linux (47 passed), not yet compiled on Windows.
Verify everything with one command on Windows: `powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1 -Verify`.

## 1. Decision

The deliverable is `dist\StudyLibrarySetup.exe`, a per-user Inno Setup installer wrapping a PyInstaller **onedir** build, because this is the only option that gives a double-click install without administrator rights, starts quickly, carries roughly 400 MB of native tools cleanly, and still produces a normal Start menu entry and uninstaller.

| Option | Verdict | Reason |
|---|---|---|
| PyInstaller onefile `StudyLibrary.exe` | Rejected as the primary download | It unpacks the whole runtime (Python, onnxruntime, Tesseract, Ghostscript, FFmpeg) into `%TEMP%` on every launch, which costs tens of seconds, is the pattern antivirus heuristics flag most, and gives no shortcuts, upgrade path or uninstaller. |
| PyOxidizer | Rejected | Its maintainer stepped back from active development, and it breaks packages that rely on `__file__`, which ML and OCR libraries commonly do. |
| Electron or Tauri | Rejected | Both would still need a PyInstaller-built Python sidecar, so they add a Node or Rust toolchain and 100 MB or more without removing any of the Python packaging work; they only make sense if the UI is being rewritten. |
| NSIS | Viable, not chosen | Downloads with progress and hash checks need third-party plugins, whereas Inno Setup 6.1+ has `CreateDownloadPage` with SHA256 verification built in. |
| **PyInstaller onedir + Inno Setup** | **Chosen** | Fast start, per-user install with no UAC prompt, built-in verified downloads for the voice models, Restart Manager integration, and a clean upgrade story through a stable `AppId`. |

## 2. Prerequisite policy

| Dependency | Policy | Where it ends up | Why |
|---|---|---|---|
| FFmpeg 7.1 essentials (GyanD) | Bundled | `{app}\vendor\ffmpeg\bin` | Static build, no installer, about 170 MB unpacked. |
| Tesseract 5.4.0 (UB Mannheim) | Bundled, extracted from the NSIS installer with 7-Zip, training tools pruned | `{app}\vendor\tesseract` | Includes `eng` and `osd`; `TESSDATA_PREFIX` is forced to the bundled `tessdata`. |
| Ghostscript 10.04.0 | Bundled, extracted with 7-Zip, plus app-local `vcruntime140.dll`, `vcruntime140_1.dll`, `msvcp140.dll` | `{app}\vendor\ghostscript\bin` | `objdump` showed `gsdll64.dll` imports those three CRT DLLs, which a clean Windows install may lack. |
| LibreOffice | Not bundled; detected, optional installer task runs `winget install TheDocumentFoundation.LibreOffice` | System install | About 350 MB, needs a machine-wide MSI and UAC; the app degrades without it. |
| Kokoro v1.0 ONNX model and voices | Downloaded by the installer with SHA256 check; repaired by the launcher in the background | `%LOCALAPPDATA%\StudyLibrary\models\kokoro` | 354 MB that changes rarely; keeping it out of the installer keeps rebuilds and re-downloads small. |
| `.env` credentials | Never bundled; a secret-free template is seeded on first run and the user is offered Notepad for any `@required` key | `%LOCALAPPDATA%\StudyLibrary\.env` | Anything inside an `.exe` can be extracted, so shipping real keys would leak them to every recipient. |

All archive and model hashes in `manifest.json` were computed from the real upstream files on 2026-11-16 and every extracted layout was checked against the `expect` lists.

## 3. Filesystem layout and invariants

```
%LOCALAPPDATA%\Programs\StudyLibrary\        {app}: replaced wholesale on upgrade, read-only to the app
  StudyLibrary.exe                            PyInstaller bootloader (windowed)
  _internal\                                  Python runtime, app code, manifest.json, env.template
  vendor\{ffmpeg,tesseract,ghostscript}\      bundled tools
  unins000.exe
%LOCALAPPDATA%\StudyLibrary\                  home: all mutable state, survives upgrades
  .env  data\  models\  logs\  instance.lock  instance.json
```

1. The app never writes under `{app}`; every mutable path derives from `home` (`slruntime.home_dir`, slruntime.py:140), overridable with `STUDY_LIBRARY_HOME`.
2. At most one launcher holds `home\instance.lock` (`FileLock`, slruntime.py:346); the kernel drops it on process death, so stale locks cannot exist.
3. `instance.json` is deleted immediately after the lock is taken (launcher.py:172), so any copy seen by a second launch belongs to the live process.
4. A model file at its final path was produced only by `os.replace` of a fully downloaded `.part` whose SHA256 matched (slassets.py:224); a stamp `<file>.ok` records hash, size and mtime so later launches skip rehashing.
5. `.env` is created only if absent, via `os.link` which refuses to overwrite (slruntime.py:309); process environment always wins over the file (`load_env_file`, slruntime.py:264).
6. Bundled tools override user environment variables for that tool (slruntime.py:227, slruntime.py:229); data locations only fill gaps (slruntime.py:234).
7. A build never proceeds with an unpinned hash unless `-PinHashes` is passed, and the build fails if any `.env*` file or a secret-looking value appears in the output (`scan_dist`, build_helpers.py:259).
8. A vendor tool directory is replaced only after its new extraction passed validation (build_helpers.py:140), so a changed upstream layout leaves the previous good copy in place.

## 4. Public interfaces

`slruntime.py`
- `home_dir(env=os.environ) -> Path`; `ensure_layout(home: Path) -> Dict[str, Path]` (keys `home, data, models, logs`; raises `OSError` when not writable).
- `load_manifest(path) -> dict`; `tool_specs(manifest) -> List[ToolSpec]`; both raise `ManifestError` on malformed entries or paths escaping their root (`safe_relative`).
- `resolve_tool(spec, vendor, env) -> ToolStatus(name, source in {"bundled","system","missing"}, path, required)`.
- `apply_environment(specs, vendor, home, env) -> Dict[str, ToolStatus]`; idempotent; sets `PATH`, each tool's `env_dirs`/`env_exe`, `STUDY_DATA_DIR`, `STUDY_MODELS_DIR`, `HF_HOME`.
- `parse_env_text(text) -> Dict[str,str]`; `load_env_file(path, env) -> List[str]`; `required_keys(template_text) -> List[str]`; `missing_keys(keys, env) -> List[str]`; `seed_env_file(target, template) -> bool`.
- `FileLock(path).acquire(timeout=0.0) -> bool`, `.release()`; context manager raises `RuntimeError` if locked.
- `write_instance_info(home, url)`, `read_instance_info(home) -> dict | None`, `clear_instance_info(home)`.
- `message_box(title, text, kind in {"info","error","question"}) -> bool` (True for OK or Yes; False off Windows).

`slassets.py`
- `AssetSpec(name, url, sha256, dest, size=None, env=None)`; `asset_specs(manifest) -> List[AssetSpec]` (https only, dest relative).
- `ensure_asset(spec, models_dir, *, opener=None, progress=None, lock_timeout=600.0) -> Path`; raises `AssetConfigError` (unpinned), `AssetIntegrityError` (hash mismatch, partial deleted), `AssetDownloadError` (network or disk, partial kept for resume), `AssetBusyError` (lock timeout or destination in use).
- `ensure_assets(specs, models_dir) -> Dict[str, str]` returns `"ok"` or the error text per asset and never raises `AssetError`.
- `export_asset_env(specs, models_dir, env)` sets e.g. `KOKORO_MODEL_PATH` with `setdefault`.

`launcher.py` (compiled into `StudyLibrary.exe`)
- `StudyLibrary.exe` runs `STUDY_ENTRY` (default `study.desktop:main`), returns its int result or 0, and returns 1 after showing a dialog that names `logs\launcher.log` on an unhandled exception.
- `StudyLibrary.exe --self-test REPORT.json` exits 0 only if every required tool resolved and its `check_args` exited 0, every asset is pinned and the entry module imports. Report keys: `ok, frozen, install_dir, home, env_file, missing_keys, tools{name:{source,path,required,exit_code,output}}, assets, entry{spec,importable,error?}, errors[]`.

`build_helpers.py` subcommands: `fetch --cache --vendor [--seven-zip] [--system-dir] [--pin] [--verify-assets]`, `gen-inno [--out]`, `env-template --root --out`, `scan --dist`, `numeric-version TAG`. Every failure prints one line and exits 1.

`build.ps1` parameters: `-Version`, `-PythonExe`, `-PinHashes`, `-Verify`, `-Publish`, `-SkipTests`. Outputs `dist\StudyLibrarySetup.exe` and `dist\StudyLibrarySetup.exe.sha256`. Optional signing reads `SL_SIGN_PFX` and `SL_SIGN_PASSWORD`. Publishing reads `R2_ACCOUNT_ID`, `R2_BUCKET`, `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and uploads `releases/<version>/StudyLibrarySetup.exe`, its `.sha256`, `latest/StudyLibrarySetup.exe`, and finally `latest.json`, so the pointer never references an object that has not landed.

Installer switches beyond Inno's own: `/SKIPMODELS=1` skips the voice download (the launcher repairs it later).

## 5. Assumptions about the existing repository (not supplied; verify first)

No repository was available while designing, so every statement about existing code is an assumption with the command that confirms it.

| Id | Assumption | Verify with | If false |
|---|---|---|---|
| A1 | `backend/study/desktop.py` defines a callable `main()` returning int or None. | `grep -n "def main" backend/study/desktop.py` | Change `DEFAULT_ENTRY` (launcher.py) to the real `module:function`. |
| A2 | Importing `study.desktop` has no side effects; start-up is behind `if __name__ == "__main__"` or inside `main()`. | `grep -n "__main__" backend/study/desktop.py` | Move start-up code into `main()`; otherwise `--self-test` would launch the app. |
| A3 | The app finds Tesseract, Ghostscript and FFmpeg through `PATH` or the variables the launcher sets (`TESSERACT_CMD`, `FFMPEG_BINARY`, `IMAGEIO_FFMPEG_EXE`, `STUDY_GHOSTSCRIPT`, `STUDY_SOFFICE`). | `grep -rnE "tesseract_cmd|gswin|ffmpeg|soffice" backend/` | Replace hard-coded paths with `os.environ.get(...)` or `shutil.which(...)`. |
| A4 | The database and library files can be pointed at `STUDY_DATA_DIR`. | `grep -rnE "sqlite|\.db\b|DATA_DIR|Path\(__file__\)" backend/study` | Milestone M3 changes the config default to `os.environ.get("STUDY_DATA_DIR", <current default>)`. |
| A5 | TTS uses `kokoro-onnx` with the v1.0 files and accepts paths from `KOKORO_MODEL_PATH` and `KOKORO_VOICES_PATH`. | `grep -rn "kokoro" backend/ requirements*.txt` | For the PyTorch `kokoro` package, replace the two assets with the Hugging Face files and expect roughly 1 GB more in the bundle. |
| A6 | Dependencies are in `backend/requirements.txt`, `requirements.txt` or a `pyproject.toml`. | `ls backend/requirements.txt requirements.txt backend/pyproject.toml` | Point `Install-Dependencies` (build.ps1:87) at the real file. |
| A7 | `.env` is read with `python-dotenv` without `override=True`, so the launcher's pre-loaded values are respected. | `grep -rn "load_dotenv" backend/` | Remove `override=True` or read from `os.environ` only. |
| A8 | Static front-end files, if any, are found relative to the `study` package or `frontend/dist`. | `grep -rnE "static|frontend|templates" backend/study/desktop.py` | Use `Path(getattr(sys, "_MEIPASS", <repo root>)) / "frontend/dist"`. |

## 6. Milestones

1. **M1** Copy the files in `file_plan` into the repository and add `build/` and `dist/` to `.gitignore`. Done when `python -m pytest -q tests/packaging` passes on any OS.
2. **M2** Check A1 to A8 and adjust `DEFAULT_ENTRY`, `COLLECT` in `studylibrary.spec` and `env.template` (or rely on `.env.example`, which `env-template` sanitises automatically).
3. **M3** Minimal app changes: honour `STUDY_DATA_DIR` (A4); optionally, after the server binds, call `slruntime.write_instance_info(slruntime.home_dir(), url)` inside `try: import slruntime except ImportError: pass` so that a second double-click opens the running instance.
4. **M4** On Windows, `powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1` produces `dist\StudyLibrarySetup.exe`.
5. **M5** `build.ps1 -Verify` passes: silent install, frozen self-test, uninstall.
6. **M6** Optional: configure signing and R2 secrets, then push a `v*` tag so `.github/workflows/windows-installer.yml` builds, verifies and publishes.

## 7. Failure modes

| Trigger | Detection | Recovery |
|---|---|---|
| User double-clicks twice | Second `FileLock.acquire()` fails | Opens the running instance's URL from `instance.json`, else an "already running" dialog; exit 0. |
| App crashes while running | Kernel releases the lock | Next launch proceeds; nothing to clean up. |
| Two launches race to seed `.env` | `os.link` raises `FileExistsError` | Loser keeps the winner's file; user edits are never clobbered. |
| Model download interrupted (network drop, app closed mid-download) | `AssetDownloadError`; `.part` remains | Next attempt resumes with `Range`; whole-file hash still verified. |
| Server ignores `Range` | Status 200 instead of 206 | Restart from zero with `wb`. |
| Corrupt or truncated `.part` beyond the real size | Size check or 416 | `.part` deleted and download restarted. |
| Corrupt model on disk, or tampered upstream file | Stamp mismatch then hash mismatch | Re-downloaded; tampered download rejected with `AssetIntegrityError`. |
| Two threads or processes download the same model | Per-asset `FileLock` with re-check after acquisition | Exactly one download (tested). |
| Installer offline or download cancelled | Inno `Download` raises | User may continue; launcher downloads in the background on first start. |
| Disk full during download | `OSError` wrapped as `AssetDownloadError` | Prefix data kept; resumes when space returns. |
| Model file locked by the running app during repair | `PermissionError` on `os.replace` | `AssetBusyError`; retried next launch. |
| Required `.env` keys empty | `missing_keys` non-empty | Question dialog offers Notepad on the file; app still starts. |
| Stale `TESSDATA_PREFIX` from an old system install | Bundled tool resolves first | Bundled value overrides the variable. |
| Clean Windows without the VC++ runtime | Ghostscript would fail to load `gsdll64.dll` | App-local CRT DLLs copied beside it at build time; self-test runs Ghostscript's interpreter. |
| `print()` in a windowed exe | `sys.stdout is None` | Streams redirected to `logs\stdout.log` and `stderr.log` before anything imports. |
| `multiprocessing` in the frozen app | Child processes re-running the launcher | `multiprocessing.freeze_support()` in `__main__` (launcher.py:197). |
| Upgrade leaves modules from the old version | Stale files in `_internal` | `[InstallDelete]` removes `_internal` and `vendor` first; data in home untouched. |
| Upgrade while the app is open | Inno Restart Manager | `CloseApplications=yes` asks the user to close it. |
| Upstream asset changed or re-uploaded | SHA256 mismatch at build | Build fails loudly; maintainer reviews and re-pins with `-PinHashes`. |
| Upstream archive layout changed | `expect` list missing files | Build fails; previous vendor copy kept. |
| Zip entry tries to escape (zip slip) | Resolved path outside staging | `BuildError`. |
| Developer `.env` swept into the bundle by `collect_all` | Spec filter and `scan_dist` | Removed by the spec, and the build fails if one still appears. |
| Partial artefacts from an aborted build | `.part` files, staging folders | Downloads use `.part` then `os.replace`; extraction uses a staging directory removed in `finally`. |
| Publishing interrupted | `latest.json` uploaded last | Users keep the previous release until every object exists. |
| AWS CLI checksum headers rejected by R2 | Upload error | `AWS_REQUEST_CHECKSUM_CALCULATION=when_required` set before uploads. |

## 8. Acceptance criteria

1. Packaging logic is correct on any OS: `python -m pytest -q tests/packaging` reports all tests passing, with `test_installed_exe.py` skipped.
2. The manifest is pinned and safe: `python -m pytest -q tests/packaging/test_runtime.py::test_shipped_manifest_is_valid_and_pinned`.
3. Resumable, verified, single-flight downloads: `python -m pytest -q tests/packaging/test_assets.py`.
4. Kernel-released single-instance lock: `python -m pytest -q tests/packaging/test_runtime.py::test_file_lock_released_when_holder_process_dies`.
5. No secrets ship: `python -m pytest -q tests/packaging/test_build_helpers.py::test_env_template_sanitised_and_scanned` plus the `scan` step inside `build.ps1`.
6. Real tool archives extract to the expected layout: `python packaging/windows/build_helpers.py fetch --cache build/windows/cache --vendor build/windows/vendor --seven-zip 7z --system-dir <dir with the three CRT DLLs>` exits 0 (works on Linux with `p7zip-full`).
7. The installer builds and the installed, frozen app passes its self-test with all three tools bundled and runnable, then uninstalls cleanly: `powershell -ExecutionPolicy Bypass -File packaging\windows\build.ps1 -Verify` exits 0.
8. CI parity: the `Windows installer` workflow succeeds on `workflow_dispatch`.

## 9. Open risks

1. The repository was not available, so A1 to A8 are unverified; M2 exists to settle them before the first Windows build.
2. `installer.iss` and `build.ps1` were not executed on Windows. `build.ps1` passes the PowerShell 7.4 parser, and the Pascal follows the Inno Setup 6.3 download-page API, but the first ISCC run may surface a typo.
3. Without Authenticode signing, SmartScreen shows "Windows protected your PC" until reputation builds; users can choose More info then Run anyway. Azure Trusted Signing is the cheapest route that removes this.
4. PyInstaller bootloaders occasionally trigger antivirus false positives; onedir, no UPX and signing reduce this, and false positives can be reported to Microsoft.
5. Licences: Ghostscript is AGPL-3.0 and the FFmpeg build is GPL; distributing them to other people may oblige source availability or, for Ghostscript in a closed product, a commercial licence from Artifex. Tesseract and the Kokoro weights are Apache-2.0. A `THIRD_PARTY_NOTICES.txt` should be added before public distribution, and this is not legal advice.
6. If `.env` holds the developer's own R2 keys that every user needs, there is no safe way to ship them; each user needs their own credentials or the app needs a small server issuing presigned URLs.
7. The installer is likely to be roughly 200 to 400 MB, with a further 354 MB of voices downloaded at install time; R2 has no egress fees, which makes it a good host for this.
8. The pinned tool versions date from 2024; they are stable, but bumping them means editing `url`, clearing `sha256`, and running `build.ps1 -PinHashes`.
