"""Layout and behaviour audit. Seeds realistic data across taught modules,
a dissertation module with sections and key dates, the job search, lecture and
seminar sessions, reader in PDF and text views, search and settings.

Visits every screen at widths 320, 375, 390, 768, 1024, 1280 and 1440, in light
and dark themes.

Checks for:
1. Text cut off or overflowing its box (including ellipsis without full text available).
2. Elements overlapping each other.
3. Controls smaller than 44 points at touch widths (<= 768px).
4. Page scrolling sideways.
5. Study Library design behaviour rules:
   - Visible Cancel/Close on every sheet, panel, dialog, menu, form and editing state.
   - Phone back gesture closes open sheets/dialogs before leaving the page.
   - Focus returns to opening button when dialog/menu closes.
   - Double tap on Save/Add creates only one item (button disabled from first tap).
   - Search boxes have a clear button.
   - Keyboard never covers the field being typed in on a phone.

Saves a screenshot for every issue found.
"""
import json, os, re, sys, time
from datetime import date, timedelta
from pathlib import Path
import pymupdf
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8790"
OUT = HERE / "shots" / "audit"
OUT.mkdir(parents=True, exist_ok=True)
FILES = HERE / "files"
FILES.mkdir(exist_ok=True)

WIDTHS = [
    (320, 568, "w320-iphone-se1"),
    (375, 667, "w375-iphone-se"),
    (390, 844, "w390-iphone-14"),
    (768, 1024, "w768-ipad-mini"),
    (1024, 768, "w1024-laptop"),
    (1280, 800, "w1280-desktop"),
    (1440, 900, "w1440-wide"),
]
THEMES = ["light", "dark"]

CHECKS = r"""
([isTouch, isPhone]) => {
  const faults = [];
  const vis = (el) => {
    if (!el) return false;
    const r = el.getBoundingClientRect();
    const s = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
  };

  const name = (el) => {
    if (!el) return 'none';
    const tag = el.tagName.toLowerCase();
    const cls = el.className && typeof el.className === 'string'
      ? '.' + el.className.trim().split(/\s+/).slice(0, 2).join('.')
      : '';
    const txt = el.textContent ? ` "${el.textContent.trim().slice(0, 45).replace(/\s+/g, ' ')}"` : '';
    return `${tag}${cls}${txt}`;
  };

  const layered = (el) => el.closest('dialog, .menu-panel, .toast, .rec-pill, .floating, .drop-banner, .move-dock, .bn-suggestion-menu, .bn-toolbar, [data-floating-ui-portal], .mantine-Popover-dropdown, .reader-progress, .highlight-bar');

  // 1. Page scrolling sideways
  const root = document.scrollingElement || document.documentElement;
  if (root.scrollWidth > window.innerWidth + 1) {
    faults.push({
      type: "page_scrolls_sideways",
      msg: `Page scrolls sideways: scrollWidth ${root.scrollWidth}px > viewport ${window.innerWidth}px`,
      selector: "body"
    });
  }

  // 1b. Elements off the right edge without overflow container
  for (const el of document.querySelectorAll('body *')) {
    if (!vis(el) || layered(el)) continue;
    const r = el.getBoundingClientRect();
    if (r.right > window.innerWidth + 2 && !el.closest('.table-wrap, .navs, .scroller, .pdf-slot, .thumbs, .transcript, .bn-editor, .picker, pre, code')) {
      const s = getComputedStyle(el.parentElement);
      if (s.overflowX === 'hidden' || s.overflowX === 'auto' || s.overflowX === 'scroll') continue;
      faults.push({
        type: "off_right_edge",
        msg: `Element off right edge: ${name(el)} (${Math.round(r.right)}px > ${window.innerWidth}px)`,
        selector: name(el)
      });
      break;
    }
  }

  // 2. Text cut off or overflowing its box
  for (const el of document.querySelectorAll('h1, h2, h3, p, span, button, a, label, .reading, .module-row, .badge, .chip, .kd-label, .kd-when, .c-employer, .c-role, .deadline, .where')) {
    if (!vis(el) || layered(el) || el.closest('.bn-editor, .textLayer, .pdf-page, svg, pre, code, .sr-only') || el.classList.contains('sr-only')) continue;
    const s = getComputedStyle(el);
    const r = el.getBoundingClientRect();

    // 2a. Horizontal overflow with overflow hidden and NO ellipsis
    if (el.scrollWidth > el.clientWidth + 3) {
      if ((s.overflowX === 'hidden' || s.overflow === 'hidden' || s.overflowX === 'clip') && s.textOverflow !== 'ellipsis') {
        faults.push({
          type: "text_clipped_no_ellipsis",
          msg: `Text clipped without ellipsis: ${name(el)} (scrollWidth ${el.scrollWidth} > clientWidth ${el.clientWidth})`,
          selector: name(el)
        });
      } else if (s.textOverflow === 'ellipsis') {
        // Truncated with ellipsis - verify full text is accessible via title or aria-label
        const full = el.getAttribute('title') || el.getAttribute('aria-label') || el.closest('[title]')?.getAttribute('title');
        const text = el.textContent?.trim() || '';
        if (!full && text.length > 20) {
          faults.push({
            type: "text_truncated_no_full_text",
            msg: `Text truncated with ellipsis but full text not accessible via title/aria-label: ${name(el)}`,
            selector: name(el)
          });
        }
      } else if (s.overflowX === 'visible' && el.parentElement) {
        const pr = el.parentElement.getBoundingClientRect();
        const ps = getComputedStyle(el.parentElement);
        if (ps.overflowX === 'visible' && r.right > pr.right + 4 && !el.closest('.table-wrap, .navs, .scroller')) {
          faults.push({
            type: "text_overflows_parent",
            msg: `Text overflows parent boundary: ${name(el)} extends ${Math.round(r.right - pr.right)}px past parent`,
            selector: name(el)
          });
        }
      }
    }

    // 2b. Vertical overflow where text is clipped vertically
    if (el.scrollHeight > el.clientHeight + 4 && (s.overflowY === 'hidden' || s.overflow === 'hidden' || s.overflowY === 'clip')) {
      faults.push({
        type: "text_clipped_vertically",
        msg: `Text clipped vertically: ${name(el)} (scrollHeight ${el.scrollHeight} > clientHeight ${el.clientHeight})`,
        selector: name(el)
      });
    }
  }

  // 3. Elements overlapping each other
  const pinned = [...document.querySelectorAll('body *')].filter((el) => ['sticky', 'fixed'].includes(getComputedStyle(el).position));
  const underPin = (el) => pinned.some((p) => p.contains(el));
  const candidateTexts = [...document.querySelectorAll('body *')].filter((el) =>
    vis(el) && !layered(el) && !underPin(el) && getComputedStyle(el).display !== 'inline'
    && [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    && !el.closest('.textLayer, .pdf-page, svg, .bn-editor, pre, code'));

  const boxes = candidateTexts.map((el) => [el, el.getBoundingClientRect()]);
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const [a, ra] = boxes[i], [b, rb] = boxes[j];
      if (a.contains(b) || b.contains(a)) continue;
      const w = Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left);
      const h = Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top);
      if (w > 4 && h > 4 && (w * h) > 0.25 * Math.min(ra.width * ra.height, rb.width * rb.height)) {
        faults.push({
          type: "elements_overlap",
          msg: `Elements overlap: ${name(a)} overlaps ${name(b)} by ${Math.round(w)}x${Math.round(h)}px`,
          selector: `${name(a)} ^ ${name(b)}`
        });
      }
    }
  }

  // 4. Controls smaller than 44 points at touch widths
  if (isTouch) {
    for (const el of document.querySelectorAll('button, a[href], input:not([type=hidden]), select, textarea, [role=button], [role=menuitem]')) {
      if (!vis(el) || layered(el) || el.closest('.bn-container, .pdf-page, .tv-body, .textLayer, .bn-editor')) continue;
      const r = el.getBoundingClientRect();
      // Check if element or its pseudo-elements have hit target >= 44x44
      let effectiveW = r.width;
      let effectiveH = r.height;

      // Check if pseudo before/after expands touch area
      try {
        const before = window.getComputedStyle(el, '::before');
        if (before && before.content && before.content !== 'none' && before.position === 'absolute') {
          const top = parseFloat(before.top) || 0;
          const bottom = parseFloat(before.bottom) || 0;
          const left = parseFloat(before.left) || 0;
          const right = parseFloat(before.right) || 0;
          effectiveW += Math.max(0, -left - right);
          effectiveH += Math.max(0, -top - bottom);
        }
      } catch (e) {}

      if (effectiveW < 43 || effectiveH < 43) {
        // Special case: inline text links inside running text paragraphs are exempt from 44px height (WCAG 2.5.8),
        // but standalone buttons, tools, chips, nav links, icon buttons MUST be >= 44x44
        const isInlineTextLink = el.tagName.toLowerCase() === 'a' && (
          getComputedStyle(el).display === 'inline' ||
          el.closest('p, dd, .meta, .footnote, .crumbs')
        );
        if (!isInlineTextLink) {
          faults.push({
            type: "touch_target_too_small",
            msg: `Control smaller than 44 points on touch screen: ${name(el)} (${Math.round(r.width)}x${Math.round(r.height)}px)`,
            selector: name(el)
          });
        }
      }
    }
  }

  return faults;
}
"""


def create_files():
    """Create realistic PDFs with long titles and multi-page texts."""
    f1 = FILES / "(AT1) Chen, J. (2001) 'Introduction', in Mao's China and the Cold War, pp. 1-16.pdf"
    if not f1.exists():
        doc = pymupdf.open()
        for p in range(3):
            page = doc.new_page()
            page.insert_text((72, 80), f"Page {p+1}. Cold War studies and comparative perspectives.", fontsize=11)
        doc.save(f1)

    f2 = FILES / "(AT1) P1 Mao Zedong, 'On the Question of the Differentiation of the Three Worlds: Archive of the Central Committee', 22 Feb 1974.pdf"
    if not f2.exists():
        doc = pymupdf.open()
        for p in range(3):
            page = doc.new_page()
            page.insert_text((72, 80), f"Page {p+1}. Primary source memorandum on international alignments.", fontsize=11)
        doc.save(f2)

    f3 = FILES / "(AT2) Kirby, W. C. (1997) 'The Internationalization of China: Foreign Relations at Home and Abroad in the Republican Era', China Quarterly 150, pp. 433-58.pdf"
    if not f3.exists():
        doc = pymupdf.open()
        for p in range(3):
            page = doc.new_page()
            page.insert_text((72, 80), f"Page {p+1}. Institutional foreign relations and national sovereignty.", fontsize=11)
        doc.save(f3)

    # Lecture slides
    slides_path = FILES / "Lecture 1 slides.pdf"
    if not slides_path.exists():
        doc = pymupdf.open()
        for n in range(4):
            page = doc.new_page(width=960, height=540)
            page.insert_text((60, 90), f"Lecture 1, slide {n + 1}: Migration, Citizenship and the Politics of Belonging", fontsize=28)
            for i, line in enumerate(["Global migration trends and citizenship definitions", "Sovereignty, borders and inclusion", "Methodological nationalism in historical analysis", "Readings for next week"]):
                page.insert_text((80, 170 + i * 50), f"• {line}", fontsize=20)
        doc.save(slides_path)

    # Long text for textview
    tv_path = FILES / "(AT1) Long Text Containment.pdf"
    if not tv_path.exists():
        doc = pymupdf.open()
        for n in range(3):
            page = doc.new_page()
            page.insert_text((60, 40), "Diplomatic History", fontsize=8)
            page.insert_text((540, 40), str(101 + n), fontsize=8)
            page.insert_text((60, 80), f"Chapter {n+1}: The Long Telegram and Geopolitical Realignment", fontsize=16)
            for j in range(12):
                page.insert_text((60, 120 + j * 20), f"Paragraph {j+1}: The transformation of the post-war diplomatic environment in Europe and East Asia shaped subsequent alliance systems across multiple continents.", fontsize=10)
        doc.save(tv_path)


def until(page, script, timeout=30):
    end = time.time() + timeout
    while time.time() < end:
        if page.evaluate(script):
            return
        time.sleep(0.4)
    raise AssertionError("timed out: " + script[:100])


def seed_database(browser):
    """Seed comprehensive realistic data."""
    create_files()
    page = browser.new_page(viewport={"width": 1280, "height": 900})
    page.request.post(BASE + "/api/dev/reset")

    # 1. Taught Module: SP335 with long title
    page.goto(BASE + "/")
    page.get_by_label("Code").fill("SP335")
    page.get_by_label("Title").fill("Migration, Citizenship and the Politics of Belonging in Comparative Perspective: Global Historical Frameworks")
    page.get_by_role("button", name="Create module").click()
    page.wait_for_selector("#week-AT1", timeout=20000)

    # Upload readings to AT1
    page.locator("#week-AT1 .week-title").click()
    readings = [str(FILES / f) for f in os.listdir(FILES) if f.endswith(".pdf") and f.startswith("(AT")]
    page.locator("input[type=file][accept='.pdf,.pptx,.ppt,.docx,.doc,image/*,.heic,.heif']").first.set_input_files(readings)

    # Upload slides to first lecture session
    lecture = page.locator("section.session").first
    if lecture.get_by_role("button", name="Add slides").count():
        with page.expect_file_chooser() as chooser:
            lecture.get_by_role("button", name="Add slides").click()
        chooser.value.set_files(str(FILES / "Lecture 1 slides.pdf"))
        page.wait_for_timeout(1000)
    until(page, "async () => { const j = await (await fetch('/api/sync/pull?since=0')).json(); return (j.rows.files || []).length >= 3; }")

    # Add seminar questions to seminar session
    page.locator("section.session").nth(1).get_by_label("Add a question").fill(
        "1. Who counts as a citizen or migrant across varying jurisdictions, and how do imperial legacies continue to govern contemporary border control?\n"
        "2. To what extent does methodological nationalism distort historical explanations of transnational diaspora communities?\n"
        "3. In evaluating migration statistics between 1880 and 1914, do gross flow indices provide a superior metric compared to net stock measures?"
    )
    page.locator("section.session").nth(1).get_by_label("Add a question").press("Enter")

    # Add lecture notes and transcript
    page.locator("section.session").first.locator(".session-title a").click()
    page.locator(".session-notes .bn-editor").click()
    for line in [
        "The lecture addressed the historiographical shift from nation-state centric perspectives to transnational mobility patterns.",
        "Definitions of migration: operational thresholds (12-month residency requirement) versus constitutional status categories.",
        "Three foundational pillars of methodological nationalism according to Wimmer and Glick Schiller."
    ] * 6:
        page.keyboard.type(line)
        page.keyboard.press("Enter")

    transcript_fixture = HERE / "fixtures" / "moodle-transcript.txt"
    if transcript_fixture.exists():
        page.locator("input[type=file][accept^='.txt']").set_input_files(str(transcript_fixture))
        page.wait_for_timeout(1000)

    # 2. Dissertation Module: HY300 with sections and key dates
    page.goto(BASE + "/")
    page.wait_for_selector("h1", timeout=15000)
    page.get_by_role("button", name="Add a module").click()
    page.wait_for_selector("form.section", timeout=10000)
    page.get_by_role("button", name="A dissertation, by sections you name").click()
    page.get_by_label("Code").fill("HY300")
    page.get_by_label("Title").fill("The Monroe Doctrine, British Naval Supremacy and Imperial Rivalries in Latin America, 1823-1904")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY300", exact=True)).to_be_visible()

    # Rename section 1 and add section 2
    page.get_by_role("button", name="More actions for Section 1").click()
    page.get_by_role("menuitem", name="Rename").click()
    page.get_by_label("Section name").fill("Chapter 1: The Historiographical Debate Concerning Continental Imperialism")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)

    page.get_by_role("button", name="Add a section").click()
    page.wait_for_timeout(500)
    page.get_by_role("heading", name="Section 2").click()
    page.get_by_label("Section name").fill("Primary Archival Records: Foreign Office Correspondence")
    page.keyboard.press("Enter")
    page.wait_for_timeout(500)

    # Add key dates
    today = date.today()
    page.locator(".crumbs a").first.click()
    page.get_by_role("button", name="Add a date").click()
    page.get_by_label("What").fill("First proposal and preliminary bibliography draft submission")
    page.get_by_label("When").fill((today + timedelta(days=4)).isoformat())
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_timeout(400)

    page.get_by_role("button", name="Add a date").click()
    page.get_by_label("What").fill("Final dissertation submission to Department of International History")
    page.get_by_label("When").fill((today + timedelta(days=60)).isoformat())
    page.get_by_role("button", name="Add", exact=True).click()
    page.wait_for_timeout(400)

    # 3. Seed Job Applications
    iso = lambda d: d.isoformat()
    push_apps = [
        {
            "id": "pwc", "employer": "PricewaterhouseCoopers International Strategy & Advisory Services",
            "role": "Senior Graduate Strategy Consultant & Economic Policy Analyst", "stage": "oa_todo",
            "applied": iso(today - timedelta(days=10)), "next_deadline": iso(today + timedelta(days=2)),
            "notes": "Online assessment due in 48 hours. Numerical and critical reasoning sections.",
            "file_cv": {"state": "saved"}, "file_cl": {"state": "saved"}, "file_rd": None, "file_qs": None,
            "modified_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "deleted": False
        },
        {
            "id": "dbt", "employer": "Department for Business and Trade - Civil Service Fast Stream",
            "role": "Policy Lead - International Trade Negotiations & Regulatory Frameworks", "stage": "interview_todo",
            "applied": iso(today - timedelta(days=25)), "next_deadline": iso(today - timedelta(days=1)),
            "notes": "Video interview follow-up.",
            "file_cv": {"state": "saved"}, "file_cl": None, "file_rd": None, "file_qs": None,
            "modified_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "deleted": False
        },
        {
            "id": "kekst", "employer": "Kekst CNC Corporate Communications & Financial Public Affairs",
            "role": "Summer 2026 Strategy & Crisis Communications Internship", "stage": "rejected",
            "applied": "2026-02-26", "next_deadline": iso(today - timedelta(days=15)),
            "notes": "Application closed.",
            "file_cv": {"state": "saved"}, "file_cl": {"state": "saved"}, "file_rd": {"state": "saved"}, "file_qs": None,
            "modified_at": time.strftime("%Y-%m-%dT%H:%M:%S.000Z", time.gmtime()), "deleted": False
        }
    ]
    page.request.post(BASE + "/api/sync/push", data={"changes": [{"table": "applications", "row": r} for r in push_apps]})

    # Visit pages so "Recently opened" has entries
    page.goto(BASE + "/")
    page.wait_for_selector(".module-row", timeout=10000)
    page.close()


def run_audit():
    with sync_playwright() as p:
        browser = p.chromium.launch()
        print("Seeding realistic database...")
        seed_database(browser)
        print("Database seeded successfully.")

        # Collect page URLs to audit
        p_temp = browser.new_page(viewport={"width": 1280, "height": 900})
        p_temp.goto(BASE + "/")
        p_temp.wait_for_selector(".module-row")

        # Get taught module URL
        p_temp.locator(".module-row", has_text="SP335").click()
        p_temp.wait_for_selector("#week-AT1")
        taught_module_url = p_temp.url

        # Get week URL
        p_temp.locator("#week-AT1 .week-title").click()
        p_temp.wait_for_selector("section.session")
        week_url = p_temp.url

        # Get session URL
        p_temp.locator("section.session").first.locator(".session-title a").click()
        p_temp.wait_for_selector(".session-notes")
        session_url = p_temp.url

        # Get reading URL
        p_temp.goto(week_url)
        p_temp.locator("li.reading a.name").first.click()
        p_temp.wait_for_selector(".reader-bar")
        reader_url = p_temp.url

        # Get dissertation module URL and section URL
        p_temp.goto(BASE + "/")
        p_temp.locator(".module-row", has_text="HY300").click()
        p_temp.wait_for_selector(".key-dates")
        diss_module_url = p_temp.url

        p_temp.locator(".week-title").first.click()
        p_temp.wait_for_selector(".week-page")
        diss_section_url = p_temp.url
        p_temp.close()

        PAGES = [
            ("01-home", BASE + "/"),
            ("02-taught-module", taught_module_url),
            ("03-week", week_url),
            ("04-session", session_url),
            ("05-reader-pdf", reader_url),
            ("06-reader-text", reader_url + "&layout=text"),
            ("07-search", BASE + "/?v=search&q=Cold%20War%20differentiation"),
            ("08-settings", BASE + "/?v=settings"),
            ("09-across-modules", BASE + "/?v=across&term=AT&n=1"),
            ("10-jobs", BASE + "/?v=jobs"),
            ("11-dissertation-module", diss_module_url),
            ("12-dissertation-section", diss_section_url),
        ]

        all_findings = []
        shot_idx = 0

        for width, height, w_name in WIDTHS:
            is_touch = width <= 768
            is_phone = width < 500

            for theme in THEMES:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    has_touch=is_touch,
                    is_mobile=is_phone,
                )
                page = context.new_page()

                # Set theme in local storage
                page.add_init_script(f"""
                    localStorage.setItem('appearance', '{theme}');
                    document.documentElement.dataset.theme = '{theme}';
                """)

                for page_label, url in PAGES:
                    case_tag = f"{w_name}_{theme}_{page_label}"
                    try:
                        page.goto(url, wait_until="networkidle")
                    except Exception:
                        page.goto(url)

                    page.wait_for_timeout(350)

                    # For reader-text, switch into text mode if not already
                    if "reader-text" in page_label:
                        try:
                            if page.locator(".text-view").count() == 0:
                                page.get_by_role("button", name="Appearance").click(timeout=2000)
                                page.get_by_role("group", name="Layout").get_by_role("button", name="Text").click(timeout=2000)
                                page.keyboard.press("Escape")
                                page.wait_for_timeout(400)
                        except Exception:
                            pass

                    # Run layout checks
                    faults = page.evaluate(CHECKS, [is_touch, is_phone])

                    if faults:
                        shot_idx += 1
                        shot_name = f"{case_tag}_fault_{shot_idx}.png"
                        shot_path = OUT / shot_name
                        page.screenshot(path=str(shot_path), full_page=False)

                        for f in faults:
                            all_findings.append({
                                "group": f["type"],
                                "message": f["msg"],
                                "viewport": f"{width}x{height} ({w_name})",
                                "theme": theme,
                                "page": page_label,
                                "url": url,
                                "selector": f.get("selector", ""),
                                "screenshot": f"app/tests/e2e/shots/audit/{shot_name}",
                            })

                context.close()

        # Step 3: Specific Behaviour Rule Audits
        behaviour_findings = audit_behaviours(browser)
        all_findings.extend(behaviour_findings)

        browser.close()

        print(f"\n================ AUDIT SUMMARY ================")
        print(f"Total findings: {len(all_findings)}")

        # Group findings by type/cause
        by_cause = {}
        for f in all_findings:
            by_cause.setdefault(f["group"], []).append(f)

        for cause, items in by_cause.items():
            print(f"\nCause: {cause} ({len(items)} occurrences)")
            for item in items[:4]:
                print(f"  - [{item['viewport']} / {item['theme']} / {item['page']}] {item['message']}")
                print(f"    Shot: {item['screenshot']}")

        (OUT / "audit_results.json").write_text(json.dumps(all_findings, indent=2))
        return all_findings


def audit_behaviours(browser):
    """Check the Behaviour rules from the study-library-design skill."""
    findings = []
    shot_idx = 100

    # Rule 1: Every sheet, panel, dialog, menu, form and editing state has a visible Cancel (or Close)
    # Check Home NewModule form
    p = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    p.goto(BASE + "/")
    p.wait_for_selector(".module-row")
    p.get_by_role("button", name="Add a module").click()
    p.wait_for_selector("form.section")
    cancel_btns = p.locator("form.section").get_by_role("button", name=re.compile(r"cancel|close", re.I))
    if cancel_btns.count() == 0:
        shot_idx += 1
        shot_path = OUT / f"behaviour_no_cancel_new_module_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "missing_cancel_button",
            "message": "Home NewModule form lacks a visible Cancel button",
            "viewport": "390x844",
            "theme": "light",
            "page": "Home",
            "selector": "form.section",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })

    # Check Palette (Go to dialog)
    p.keyboard.press("Control+k")
    p.wait_for_selector("dialog.palette[open]")
    palette_cancel = p.locator("dialog.palette").get_by_role("button", name=re.compile(r"cancel|close", re.I))
    if palette_cancel.count() == 0:
        shot_idx += 1
        shot_path = OUT / f"behaviour_no_cancel_palette_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "missing_cancel_button",
            "message": "Palette ('Go to') dialog lacks a visible Cancel or Close button",
            "viewport": "390x844",
            "theme": "light",
            "page": "Palette",
            "selector": "dialog.palette",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })
    p.keyboard.press("Escape")

    # Rule 2: Phone's back gesture closes anything open before leaving the page
    # Open Menu on module page
    p.goto(BASE + "/")
    p.wait_for_selector(".module-row", timeout=10000)
    p.locator(".module-row", has_text="SP335").click()
    p.wait_for_selector(".menu-button", timeout=10000)
    p.locator(".menu-button").first.click()
    p.wait_for_selector(".menu-panel", state="visible")
    url_before = p.url
    # Simulate back navigation
    p.go_back()
    p.wait_for_timeout(400)
    # If the page navigated away rather than closing the menu, it violates Rule 94
    if p.url != url_before or p.locator(".menu-panel").is_visible():
        shot_idx += 1
        shot_path = OUT / f"behaviour_back_leaves_page_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "back_gesture_leaves_page",
            "message": "Phone back gesture navigated away instead of closing the open sheet/menu",
            "viewport": "390x844",
            "theme": "light",
            "page": "Menu sheet",
            "selector": ".menu-panel",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })

    # Rule 3: Focus returns to opening button when dialog/menu closes
    p.goto(BASE + "/")
    p.wait_for_selector(".module-row")
    goto_btn = p.locator("button.goto-button")
    goto_btn.click()
    p.wait_for_selector("dialog.palette[open]")
    p.locator("dialog.palette button:has-text('Close')").click()
    p.wait_for_timeout(300)
    focused_is_goto = p.evaluate("document.activeElement.classList.contains('goto-button')")
    if not focused_is_goto:
        shot_idx += 1
        shot_path = OUT / f"behaviour_focus_lost_on_close_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "focus_not_restored",
            "message": "Focus lost to body when dialog closed instead of returning to trigger element",
            "viewport": "390x844",
            "theme": "light",
            "page": "Palette dialog",
            "selector": "dialog.palette",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })

    # Rule 4: A double tap on Save or Add creates only one item
    p.goto(BASE + "/?v=jobs")
    p.wait_for_selector("h1")
    add_btn = p.get_by_role("button", name="Add application")
    apps_before = p.locator("li.app-card").count()
    add_btn.click()
    try:
        add_btn.click(timeout=300)
    except Exception:
        pass
    p.wait_for_timeout(600)
    apps_after = p.locator("li.app-card").count()
    if apps_after > apps_before + 1:
        shot_idx += 1
        shot_path = OUT / f"behaviour_add_not_disabled_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "button_not_disabled_on_click",
            "message": "Double tap on Add application created multiple items instead of one",
            "viewport": "390x844",
            "theme": "light",
            "page": "Job search",
            "selector": "button.primary:has-text('Add application')",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })

    # Rule 5: Search boxes have a clear button
    p.goto(BASE + "/?v=search")
    p.wait_for_selector("input.search-box")
    p.locator("input.search-box").fill("Cold War")
    p.wait_for_timeout(300)
    clear_btn = p.locator(".search-page button:has-text('Clear'), .search-page button[aria-label*='Clear' i]")
    if clear_btn.count() == 0:
        shot_idx += 1
        shot_path = OUT / f"behaviour_search_lacks_clear_button_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "search_box_missing_clear",
            "message": "Search page input lacks a visible clear button when query is entered",
            "viewport": "390x844",
            "theme": "light",
            "page": "Search",
            "selector": "input.search-box",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })

    # Also check Palette search input
    p.goto(BASE + "/")
    p.wait_for_selector("h1")
    p.keyboard.press("Control+k")
    p.wait_for_selector("dialog.palette[open]")
    p.locator("dialog.palette input").fill("Monroe")
    palette_clear = p.locator("dialog.palette button:has-text('Clear'), dialog.palette button[aria-label*='Clear' i]")
    if palette_clear.count() == 0:
        shot_idx += 1
        shot_path = OUT / f"behaviour_palette_missing_clear_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "search_box_missing_clear",
            "message": "Palette ('Go to') search input lacks a visible clear button",
            "viewport": "390x844",
            "theme": "light",
            "page": "Palette",
            "selector": "dialog.palette input",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })
    p.keyboard.press("Escape")

    # Rule 6: Keyboard never covers field being typed in on a phone
    # Test on week page seminar question adder at bottom of page
    p.goto(BASE + "/")
    p.locator(".module-row", has_text="SP335").click()
    p.locator("#week-AT1 .week-title").click()
    p.wait_for_selector("textarea[aria-label='Add a question']")
    adder = p.locator("textarea[aria-label='Add a question']")
    adder.scroll_into_view_if_needed()
    adder.focus()
    p.wait_for_timeout(300)
    # Check if adder is fully inside visible viewport
    box = adder.bounding_box()
    if box and (box['y'] + box['height'] > 844):
        shot_idx += 1
        shot_path = OUT / f"behaviour_field_covered_by_keyboard_{shot_idx}.png"
        p.screenshot(path=str(shot_path))
        findings.append({
            "group": "keyboard_covers_field",
            "message": "Active input at foot of page is partially covered by viewport boundary / keyboard zone",
            "viewport": "390x844",
            "theme": "light",
            "page": "Week page",
            "selector": "textarea[aria-label='Add a question']",
            "screenshot": f"app/tests/e2e/shots/audit/{shot_path.name}"
        })

    p.close()
    return findings


if __name__ == "__main__":
    findings = run_audit()
    print(f"\nAudit complete. {len(findings)} total faults identified.")
    if findings:
        for f in findings[:20]:
            print(f"  [{f['group']}] {f['message']} ({f.get('selector', '')})")
        raise SystemExit(f"FAIL: {len(findings)} layout/behaviour faults detected.")
    print("PASS: 0 layout/behaviour faults detected across all pages, viewports and themes.")
