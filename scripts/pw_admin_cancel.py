"""
Admin cancels the harness customer's booking from the real admin UI, choosing the refund %.
usage: python scripts/pw_admin_cancel.py [percent]   (default 25)
Needs backend :18081, frontend dev server :55000, harness server :5173 (it signs the admin cookie).
"""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

percent = sys.argv[1] if len(sys.argv) > 1 else "25"
OUT = "scripts/.out"
token = json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:5173/setup-admin", method="POST")))["token"]


def shot(pg, name):
    try:
        pg.screenshot(path=f"{OUT}/{name}.png", timeout=10000)
    except Exception:
        pass


with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_cookies([{"name": "app_access_token", "value": token, "url": "http://127.0.0.1:18081"}])
    page = ctx.new_page()
    page.goto("http://127.0.0.1:55000/admin-dashboard/appointments")
    time.sleep(7)
    print("URL:", page.url)
    shot(page, "ad_1_list")
    clicked = False
    for btn in page.get_by_role("button", name="View").all():
        card = btn.locator("xpath=ancestor::div[contains(@class,'rounded')][1]").inner_text()
        if "Checkout Harness" in card and "CANCELLED" not in card.upper():
            btn.click()
            clicked = True
            break
    print("opened harness booking:", clicked)
    page.get_by_text("Booking details").wait_for(timeout=20000)
    time.sleep(1)
    shot(page, "ad_2_details")
    page.get_by_role("button", name="Cancel booking & refund").click()
    page.get_by_role("dialog").last.get_by_text("Paid by customer", exact=True).wait_for(timeout=20000)
    time.sleep(1)
    print("DIALOG:", " | ".join(page.get_by_role("dialog").last.inner_text().split("\n")))
    page.locator("#refund-percent").click()
    time.sleep(1)
    page.get_by_role("option", name=f"{percent}%", exact=False).first.click()
    time.sleep(1)
    shot(page, "ad_3_selected")
    print("AFTER SELECT:", " | ".join(page.get_by_role("dialog").last.inner_text().split("\n")))
    d = page.get_by_role("dialog").last
    d.get_by_role("button", name="Cancel & refund").or_(d.get_by_role("button", name="Cancel booking")).first.click()
    time.sleep(4)
    shot(page, "ad_4_done")
    print("TOAST:", " | ".join(t.inner_text() for t in page.locator("[data-sonner-toast]").all()))
    browser.close()
