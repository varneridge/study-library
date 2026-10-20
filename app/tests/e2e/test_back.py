"""Browser back gesture and button tests on laptop and phone.

Checks that open menus, the Go to palette, and confirmation dialogs close on:
1. Escape or Cancel
2. A tap outside
3. Browser Back

Checks that the page has not changed when each overlay closes, and that one
subsequent Back returns to the previous page.
"""
import sys
from pathlib import Path
from playwright.sync_api import sync_playwright, expect

HERE = Path(__file__).resolve().parent
BASE = sys.argv[1] if len(sys.argv) > 1 else "http://127.0.0.1:8790"


def setup_library(page):
    """Resets the database and creates a module to give a history of [Home, Module]."""
    page.request.post(BASE + "/api/dev/reset")
    page.goto(BASE + "/")
    expect(page.get_by_text("Add your first module")).to_be_visible()
    page.get_by_label("Code").fill("HY335")
    page.get_by_label("Title").fill("China and the World since 1949")
    page.get_by_role("button", name="Create module").click()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()


def check_overlay_back(page, is_phone: bool):
    setup_library(page)

    # ---------------------------------------------------------
    # 1. Go to palette (tested from Module page -> previous is Home)
    # ---------------------------------------------------------

    # 1a. Close palette with Escape or Close button
    if is_phone:
        page.locator(".goto-button").click()
    else:
        page.keyboard.press("Control+k")
    palette = page.locator("dialog.palette")
    expect(palette).to_be_visible()
    if is_phone:
        page.locator(".palette-close").click()
    else:
        page.keyboard.press("Escape")
    expect(palette).to_be_hidden()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    page.go_back()
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # 1b. Close palette with tap outside
    if is_phone:
        page.locator(".goto-button").click()
    else:
        page.keyboard.press("Control+k")
    expect(palette).to_be_visible()
    page.mouse.click(10, 10)
    expect(palette).to_be_hidden()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    page.go_back()
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # 1c. Close palette with Back
    if is_phone:
        page.locator(".goto-button").click()
    else:
        page.keyboard.press("Control+k")
    expect(palette).to_be_visible()
    page.go_back()
    expect(palette).to_be_hidden()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    page.go_back()
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # ---------------------------------------------------------
    # 2. Confirmation dialog (tested from Module settings)
    # ---------------------------------------------------------
    confirm_dialog = page.locator("dialog.dialog:has-text('Change HY335 to a dissertation?')")

    # 2a. Close confirm dialog with Cancel
    page.get_by_role("button", name="Edit module").click()
    expect(page.locator("form.editor")).to_be_visible()
    page.get_by_role("button", name="Change to a dissertation").click()
    expect(confirm_dialog).to_be_visible()
    confirm_dialog.get_by_role("button", name="Cancel").click()
    expect(confirm_dialog).to_be_hidden()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    page.locator("form.editor").get_by_role("button", name="Cancel").click()
    expect(page.locator("form.editor")).to_be_hidden()
    page.go_back()
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # 2b. Close confirm dialog with tap outside
    page.get_by_role("button", name="Edit module").click()
    expect(page.locator("form.editor")).to_be_visible()
    page.get_by_role("button", name="Change to a dissertation").click()
    expect(confirm_dialog).to_be_visible()
    page.mouse.click(10, 10)
    expect(confirm_dialog).to_be_hidden()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    page.locator("form.editor").get_by_role("button", name="Cancel").click()
    expect(page.locator("form.editor")).to_be_hidden()
    page.go_back()
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # 2c. Close confirm dialog with Back
    page.get_by_role("button", name="Edit module").click()
    expect(page.locator("form.editor")).to_be_visible()
    page.get_by_role("button", name="Change to a dissertation").click()
    expect(confirm_dialog).to_be_visible()
    page.go_back()
    expect(confirm_dialog).to_be_hidden()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    # Another Back closes ModuleSettings as well
    page.go_back()
    expect(page.locator("form.editor")).to_be_hidden()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    # One Back afterwards goes to Home
    page.go_back()
    expect(page.get_by_role("heading", name="Modules")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # ---------------------------------------------------------
    # 3. Menu: More actions for this week (on Week page -> previous is Module)
    # ---------------------------------------------------------
    page.locator(".week-title").first.click()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()
    menu_btn = page.get_by_label("More actions for this week")

    # 3a. Close menu with Escape or Cancel
    menu_btn.click()
    expect(page.locator(".menu-panel")).to_be_visible()
    if is_phone:
        page.get_by_role("menuitem", name="Cancel").click()
    else:
        page.keyboard.press("Escape")
    expect(page.locator(".menu-panel")).to_be_hidden()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()
    # One Back goes to Module page
    page.go_back()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()

    # 3b. Close menu with tap outside
    menu_btn.click()
    expect(page.locator(".menu-panel")).to_be_visible()
    if is_phone:
        page.locator(".menu-backdrop").click()
    else:
        page.mouse.click(10, 10)
    expect(page.locator(".menu-panel")).to_be_hidden()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()
    page.go_back()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()
    page.go_forward()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()

    # 3c. Close menu with Back
    menu_btn.click()
    expect(page.locator(".menu-panel")).to_be_visible()
    page.go_back()
    expect(page.locator(".menu-panel")).to_be_hidden()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()
    # One Back afterwards goes to Module page
    page.go_back()
    expect(page.get_by_role("heading", name="HY335")).to_be_visible()

    # 3d. Menu survives reload without leaving stale overlay history state
    page.go_forward()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()
    menu_btn = page.get_by_label("More actions for this week")
    menu_btn.click()
    expect(page.locator(".menu-panel")).to_be_visible()
    page.reload()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()
    menu_btn = page.get_by_label("More actions for this week")
    menu_btn.click()
    expect(page.locator(".menu-panel")).to_be_visible()
    if is_phone:
        page.get_by_role("menuitem", name="Cancel").click()
    else:
        page.keyboard.press("Escape")
    expect(page.locator(".menu-panel")).to_be_hidden()
    expect(page.get_by_role("heading", name="AT1")).to_be_visible()


with sync_playwright() as p:
    browser = p.chromium.launch()

    # Laptop
    desk = browser.new_page(viewport={"width": 1280, "height": 900})
    check_overlay_back(desk, is_phone=False)
    desk.close()

    # Phone
    phone = browser.new_page(viewport={"width": 390, "height": 844}, has_touch=True, is_mobile=True)
    check_overlay_back(phone, is_phone=True)
    phone.close()

    browser.close()
    print("ok")
