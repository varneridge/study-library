"""Test the unified top bar: alignment, one row, no wrap, tab order, pills, and responsive layout."""
import re, sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
shots = HERE / "shots"
shots.mkdir(exist_ok=True)
BASE = sys.argv[1]

WIDTHS = [
    (768, 1024),
    (1024, 768),
    (1280, 800),
    (1440, 900),
]
THEMES = ["light", "dark"]


def settle_and_shoot(page, path):
    page.evaluate("if (document.activeElement && document.activeElement !== document.body) document.activeElement.blur()")
    page.mouse.move(0, 0)
    page.evaluate("""() => new Promise(resolve => {
        let lastY = window.scrollY;
        let stable = 0;
        function check() {
            const y = window.scrollY;
            if (Math.abs(y - lastY) < 0.5) {
                stable++;
                if (stable >= 8) { resolve(); return; }
            } else {
                stable = 0;
                lastY = y;
            }
            requestAnimationFrame(check);
        }
        requestAnimationFrame(check);
    })""")
    page.screenshot(path=str(path))


def check_alignment(page, is_jobs=False):
    """Assert brand first letter and last icon's drawn glyph (or Jobs nav text) align with page text within 2px."""
    res = page.evaluate("""(isJobs) => {
        const pageEl = document.querySelector(isJobs ? '.page.wide' : '.page');
        if (!pageEl) return { ok: false, error: 'no .page element' };
        const pageRect = pageEl.getBoundingClientRect();
        const pageStyle = getComputedStyle(pageEl);
        const padLeft = parseFloat(pageStyle.paddingLeft);
        const padRight = parseFloat(pageStyle.paddingRight);
        const pageTextLeft = pageRect.left + padLeft;
        const pageTextRight = pageRect.right - padRight;

        const brand = document.querySelector('.topbar .brand');
        if (!brand) return { ok: false, error: 'no .brand element' };
        const textNode = brand.firstChild;
        const range = document.createRange();
        range.setStart(textNode, 0);
        range.setEnd(textNode, 1);
        const firstLetterLeft = range.getBoundingClientRect().left;

        let rightEdge;
        if (isJobs) {
            const jobsText = document.querySelector('.jobs-bar nav a .wide-only') || document.querySelector('.jobs-bar nav a');
            if (!jobsText) return { ok: false, error: 'no jobs nav' };
            const r = document.createRange();
            r.selectNodeContents(jobsText);
            rightEdge = r.getBoundingClientRect().right;
        } else {
            const lastGlyphParts = document.querySelectorAll('.topbar-tools .topbar-btn:last-child svg > *');
            if (!lastGlyphParts.length) return { ok: false, error: 'no settings icon glyph' };
            rightEdge = Math.max(...Array.from(lastGlyphParts).map(el => el.getBoundingClientRect().right));
        }

        const leftDiff = Math.abs(firstLetterLeft - pageTextLeft);
        const rightDiff = Math.abs(rightEdge - pageTextRight);
        return {
            ok: leftDiff <= 2.0 && rightDiff <= 2.0,
            leftDiff,
            rightDiff,
            pageTextLeft,
            firstLetterLeft,
            pageTextRight,
            rightEdge,
        };
    }""", is_jobs)
    assert res["ok"], f"Alignment mismatch (isJobs={is_jobs}): {res}"


def check_single_line_and_height(page):
    """Assert bar is one line and --topbar-h tall."""
    res = page.evaluate("""() => {
        const bar = document.querySelector('.topbar');
        const expectedH = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--topbar-h')) || 52;
        const barH = bar.getBoundingClientRect().height;
        const hOk = Math.abs(barH - expectedH) <= 1;

        const items = Array.from(bar.querySelectorAll('.brand, .modules-nav a, .topbar-across, .to-jobs, .topbar-btn, .jobs-bar nav a'))
            .filter(el => el.offsetParent !== null);
        const tops = items.map(el => el.getBoundingClientRect().top);
        const maxTop = Math.max(...tops);
        const minTop = Math.min(...tops);
        const oneLine = (maxTop - minTop) <= 3;
        return { ok: hOk && oneLine, barH, expectedH, maxTop, minTop };
    }""")
    assert res["ok"], f"Single line / height check failed: {res}"


def check_minimum_gaps(page):
    """Assert no two neighbouring items in top bar are less than 4px apart."""
    res = page.evaluate("""() => {
        const bar = document.querySelector('.topbar');
        const items = Array.from(bar.querySelectorAll('.brand, .topbar-sep, .modules-nav a, .topbar-across, .to-jobs, .topbar-btn, .jobs-bar nav a'))
            .filter(el => el.offsetParent !== null);
        items.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);

        const violations = [];
        for (let i = 0; i < items.length - 1; i++) {
            const r1 = items[i].getBoundingClientRect();
            const r2 = items[i + 1].getBoundingClientRect();
            const gap = r2.left - r1.right;
            if (gap < 3.8) {
                violations.push({
                    item1: items[i].className || items[i].textContent,
                    item2: items[i + 1].className || items[i + 1].textContent,
                    gap
                });
            }
        }
        return { ok: violations.length === 0, violations };
    }""")
    assert res["ok"], f"Gap less than 4px found: {res['violations']}"


def check_tab_order(page, expected_count):
    """Tab from the skip link visits items strictly from left to right."""
    page.locator(".skip").focus()
    last_left = -1
    for step in range(expected_count):
        page.keyboard.press("Tab")
        left = page.evaluate("""() => {
            const el = document.activeElement;
            if (!el || !el.closest('.topbar')) return null;
            return el.getBoundingClientRect().left;
        }""")
        assert left is not None, f"Tab step {step} moved focus outside topbar: activeElement={page.evaluate('document.activeElement.outerHTML')}"
        assert left > last_left, f"Tab step {step} did not move left to right: left={left}, last_left={last_left}"
        last_left = left


def check_pills(page, expected_pill_count, brand_current=False):
    """Assert exactly expected_pill_count items have the accent pill, and brands never do."""
    page.mouse.move(0, 0)
    res = page.evaluate("""async (brandCurrent) => {
        const bar = document.querySelector('.topbar');
        if (bar && bar.getAnimations) {
            await Promise.all(bar.getAnimations({ subtree: true }).map(a => a.finished.catch(() => {})));
        }
        const brand = document.querySelector('.topbar .brand');
        const brandAria = brand ? brand.getAttribute('aria-current') : null;
        const brandBg = brand ? getComputedStyle(brand).backgroundColor : null;
        const brandOk = (brandCurrent ? brandAria === 'page' : brandAria === null) && brandBg === 'rgba(0, 0, 0, 0)';

        const controls = Array.from(document.querySelectorAll('.topbar a, .topbar button'))
            .filter(el => el.offsetParent !== null);
        const filled = controls.filter(el => getComputedStyle(el).backgroundColor !== 'rgba(0, 0, 0, 0)');
        const navCurrent = document.querySelectorAll('.topbar [aria-current="page"]:not(.brand)');
        return {
            brandOk,
            brandAria,
            brandBg,
            filledCount: filled.length,
            navCurrentCount: navCurrent.length,
            filledTexts: filled.map(el => el.textContent.trim()),
        };
    }""", brand_current)
    assert res["brandOk"], f"Brand aria-current or pill check failed: {res}"
    assert res["filledCount"] == expected_pill_count and res["navCurrentCount"] == expected_pill_count, (
        f"Expected {expected_pill_count} pills, got: {res}"
    )


with sync_playwright() as p:
    browser = p.chromium.launch()

    # 1. Seed three modules
    setup_page = browser.new_page(viewport={"width": 1280, "height": 900})
    setup_page.request.post(BASE + "/api/dev/reset")
    setup_page.goto(BASE + "/")

    def create_mod(page, code, title):
        page.goto(BASE + "/")
        expect(page.locator(".page")).to_be_visible()
        add_btn = page.get_by_role("button", name="Add a module")
        if add_btn.is_visible():
            add_btn.click()
        page.get_by_label("Code").fill(code)
        page.get_by_label("Title").fill(title)
        page.get_by_role("button", name="Create module").click()
        expect(page.get_by_role("heading", name=code, exact=True)).to_be_visible()

    modules = [
        ("HY116", "International History"),
        ("HY240", "Western Political Thought"),
        ("HY300", "Dissertation"),
    ]
    for code, title in modules:
        create_mod(setup_page, code, title)

    setup_page.close()

    # 2. Assertions across 768, 1024, 1280, 1440 in light and dark
    for w, h in WIDTHS:
        for theme in THEMES:
            context = browser.new_context(
                viewport={"width": w, "height": h},
                is_mobile=False,
                has_touch=False,
                color_scheme=theme,
            )
            context.add_init_script(f"localStorage.setItem('appearance', '{theme}');")
            page = context.new_page()

            # --- HOME PAGE ---
            page.goto(BASE + "/")
            expect(page.locator(".topbar")).to_be_visible()
            expect(page.locator(".module-row")).to_have_count(3, timeout=15000)
            expect(page.locator(".this-week")).to_be_visible()
            assert page.evaluate("document.documentElement.getAttribute('data-theme')") == theme
            check_single_line_and_height(page)
            check_alignment(page, is_jobs=False)
            check_minimum_gaps(page)
            check_pills(page, expected_pill_count=0, brand_current=True)
            # Tab order on home: Study Library -> This week -> Job search -> Go to -> Search -> Settings (6 items)
            check_tab_order(page, expected_count=6)
            settle_and_shoot(page, shots / f"topbar-w{w}-{theme}-home.png")

            # --- MODULE PAGE ---
            page.locator(".module-row").first.click()
            expect(page.locator(".modules-nav a")).to_have_count(3)
            expect(page.locator(".topbar-sep")).to_be_visible()
            expect(page.locator(".week")).to_have_count(22)
            check_single_line_and_height(page)
            check_alignment(page, is_jobs=False)
            check_minimum_gaps(page)
            check_pills(page, expected_pill_count=1, brand_current=False)
            # Tab order on module: Study Library -> HY116 -> HY240 -> HY300 -> This week -> Job search -> Go to -> Search -> Settings (9 items)
            check_tab_order(page, expected_count=9)
            settle_and_shoot(page, shots / f"topbar-w{w}-{theme}-module.png")

            # --- THIS WEEK PAGE ---
            page.locator(".topbar-across").click()
            expect(page.locator("h1")).to_have_text(re.compile(r"^(This week|Week (AT|WT)\d+)$"))
            expect(page.locator(".across-module")).to_have_count(3)
            check_single_line_and_height(page)
            check_alignment(page, is_jobs=False)
            check_pills(page, expected_pill_count=1, brand_current=False)

            # --- SEARCH PAGE ---
            page.locator(".topbar-tools a[title*='Search']").click()
            expect(page.locator(".search-wrap")).to_be_visible()
            check_single_line_and_height(page)
            check_alignment(page, is_jobs=False)
            check_pills(page, expected_pill_count=1, brand_current=False)

            # --- SETTINGS PAGE ---
            page.locator(".topbar-tools a[title*='Settings']").click()
            expect(page.locator(".appearance-choice")).to_be_visible()
            check_single_line_and_height(page)
            check_alignment(page, is_jobs=False)
            check_pills(page, expected_pill_count=1, brand_current=False)

            # --- JOB SEARCH ---
            page.goto(BASE + "/?v=jobs")
            expect(page.locator(".topbar.jobs-bar.wide")).to_be_visible()
            expect(page.locator(".page.wide.jobs")).to_be_visible()
            check_single_line_and_height(page)
            check_alignment(page, is_jobs=True)
            check_pills(page, expected_pill_count=0, brand_current=True)
            # Tab order on jobs: Job search -> Back to Study Library (2 items)
            check_tab_order(page, expected_count=2)
            if w == 1440 and theme == "light":
                settle_and_shoot(page, shots / "topbar-w1440-light-jobs.png")
            elif w == 1440 and theme == "dark":
                settle_and_shoot(page, shots / "topbar-w1440-dark-jobs.png")

            context.close()

    # 3. Special test at 768px with five modules
    print("Testing 768px with five modules...")
    p5 = browser.new_page(viewport={"width": 1280, "height": 900})
    p5.goto(BASE + "/")
    expect(p5.locator(".module-row")).to_have_count(3, timeout=15000)
    for code, title in [("HY319", "Napoleon"), ("HY335", "China")]:
        create_mod(p5, code, title)
    p5.close()

    ctx768 = browser.new_context(viewport={"width": 768, "height": 1024})
    page768 = ctx768.new_page()
    page768.goto(BASE + "/")
    expect(page768.locator(".module-row")).to_have_count(5, timeout=15000)
    page768.locator(".module-row").first.click()
    expect(page768.locator(".modules-nav a")).to_have_count(5)
    expect(page768.locator(".week")).to_have_count(22)
    check_single_line_and_height(page768)
    check_alignment(page768, is_jobs=False)

    report_768 = page768.evaluate("""() => {
        const nav = document.querySelector('.modules-nav');
        const navRect = nav.getBoundingClientRect();
        const items = Array.from(nav.querySelectorAll('a'));
        const hidden = [];
        for (const a of items) {
            const r = a.getBoundingClientRect();
            if (r.left < navRect.left - 1 || r.right > navRect.right + 1) {
                hidden.push(a.textContent.trim());
            }
        }
        return {
            scrollWidth: nav.scrollWidth,
            clientWidth: nav.clientWidth,
            overflowing: nav.scrollWidth > nav.clientWidth,
            hiddenCount: hidden.length,
            hiddenCodes: hidden
        };
    }""")
    print(f"REPORT_768_FIVE_MODULES: {report_768}")
    ctx768.close()

    # 4. At 390px, assert phone bar is unchanged and tab bar shows on home
    print("Testing 390px phone layout...")
    for theme in ["light", "dark"]:
        ctx390 = browser.new_context(
            viewport={"width": 390, "height": 844},
            is_mobile=True,
            has_touch=True,
            color_scheme=theme,
        )
        ctx390.add_init_script(f"localStorage.setItem('appearance', '{theme}');")
        p390 = ctx390.new_page()
        p390.goto(BASE + "/")
        expect(p390.locator(".module-row")).to_have_count(5, timeout=15000)
        expect(p390.locator(".this-week")).to_be_visible()
        assert p390.evaluate("document.documentElement.getAttribute('data-theme')") == theme
        expect(p390.locator(".topbar .brand")).to_be_visible()
        expect(p390.locator(".topbar .sync")).to_be_attached()
        expect(p390.locator(".topbar .goto-button")).to_be_visible()
        expect(p390.locator(".topbar a.to-jobs")).to_be_visible()
        expect(p390.locator(".topbar .navs")).to_be_hidden()
        expect(p390.locator(".topbar .topbar-tools")).to_be_hidden()
        expect(p390.locator(".tab-bar")).to_be_visible()
        expect(p390.locator(".tab-bar .tab.on")).to_have_text("Home")
        phone_positions = p390.evaluate("""() => {
            const brand = document.querySelector('.topbar .brand').getBoundingClientRect();
            const gotoBtn = document.querySelector('.topbar .goto-button').getBoundingClientRect();
            const jobs = document.querySelector('.topbar a.to-jobs').getBoundingClientRect();
            return {
                brandLeft: brand.left,
                gotoLeft: gotoBtn.left,
                jobsLeft: jobs.left,
                ok: brand.left < 25 && gotoBtn.left > 240 && jobs.left > gotoBtn.right
            };
        }""")
        assert phone_positions["ok"], f"Phone bar item positions unexpected: {phone_positions}"
        check_pills(p390, expected_pill_count=0, brand_current=True)
        settle_and_shoot(p390, shots / f"topbar-w390-{theme}-home.png")

        # Open a module on phone
        p390.locator(".module-row").first.click()
        expect(p390.locator(".week")).to_have_count(22)
        expect(p390.locator(".topbar .brand")).to_be_visible()
        expect(p390.locator(".topbar .goto-button")).to_be_visible()
        expect(p390.locator(".topbar a.to-jobs")).to_be_visible()
        expect(p390.locator(".topbar .navs")).to_be_hidden()
        expect(p390.locator(".topbar .topbar-tools")).to_be_hidden()
        settle_and_shoot(p390, shots / f"topbar-w390-{theme}-module.png")
        ctx390.close()

    browser.close()
    print("All topbar assertions passed.")
