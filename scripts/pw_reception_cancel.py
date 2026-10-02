"""
Receptionist cancels the booking made by the harness customer, choosing the refund %.
usage: python scripts/pw_reception_cancel.py [percent]   (default 75)
Needs backend :18081, frontend dev server :55000, harness server :5173 (it mints the throwaway receptionist).
"""
import sys, time, json, urllib.request
from playwright.sync_api import sync_playwright

percent = sys.argv[1] if len(sys.argv) > 1 else "75"
OUT = "scripts/.out"
token = json.load(urllib.request.urlopen(urllib.request.Request("http://localhost:5173/setup-reception", method="POST")))["token"]


def shot(pg, name):
    try:
        pg.screenshot(path=f"{OUT}/{name}.png", timeout=10000)
    except Exception:
        pass


with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    ctx = browser.new_context(viewport={"width": 1280, "height": 900})
    ctx.add_cookies([{"name": "staff_access_token", "value": token, "url": "http://127.0.0.1:18081"}])
    page = ctx.new_page()
    page.goto("http://127.0.0.1:55000/reception-dashboard")
    time.sleep(6)
    print("URL:", page.url)
    shot(page, "rc_1_dashboard")
    btn = page.get_by_role("button", name="Cancel").first
    btn.wait_for(timeout=20000)
    btn.click()
    page.get_by_text("Paid by customer").wait_for(timeout=20000)
    time.sleep(1)
    shot(page, "rc_2_dialog")
    print("DIALOG:", " | ".join(page.get_by_role("dialog").inner_text().split("\n")))
    page.locator("#refund-percent").click()
    time.sleep(1)
    shot(page, "rc_3_dropdown")
    print("OPTIONS:", [o.inner_text() for o in page.get_by_role("option").all()])
    page.get_by_role("option", name=f"{percent}%", exact=False).first.click()
    time.sleep(1)
    shot(page, "rc_4_selected")
    print("AFTER SELECT:", " | ".join(page.get_by_role("dialog").inner_text().split("\n")))
    page.get_by_role("dialog").get_by_role("button", name="Cancel & refund").or_(page.get_by_role("dialog").get_by_role("button", name="Cancel booking")).first.click()
    time.sleep(4)
    shot(page, "rc_5_done")
    print("TOAST:", " | ".join(t.inner_text() for t in page.locator("[data-sonner-toast]").all()))
    browser.close()
