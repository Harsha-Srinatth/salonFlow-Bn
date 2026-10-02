"""
Phone-emulated (Pixel 7) check of the UPI Intent experience in the REAL Razorpay Checkout (test mode):
UPI apps should be the first thing shown, and tapping one should complete the payment.
usage: python scripts/pw_upi_intent.py [slotN]
"""
import sys, time
from playwright.sync_api import sync_playwright

OUT = "scripts/.out"
idx = int(sys.argv[1][4:]) if len(sys.argv) > 1 and sys.argv[1].startswith("slot") else 36


def shot(pg, name):
    try:
        pg.screenshot(path=f"{OUT}/{name}.png", timeout=10000)
    except Exception:
        pass


with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    ctx = browser.new_context(**p.devices["Pixel 7"])
    page = ctx.new_page()
    page.goto("http://localhost:5173/")
    page.click("#setup")
    page.wait_for_function("document.querySelectorAll('#slot option').length > 0")
    page.select_option("#slot", str(idx))
    page.click("#pay")
    page.wait_for_selector("iframe.razorpay-checkout-frame", timeout=30000)
    fr = page.frame_locator("iframe.razorpay-checkout-frame")
    time.sleep(6)
    shot(page, "intent_1_first_screen")
    text = " | ".join(fr.locator("body").inner_text().split()[:40])
    print("FIRST SCREEN:", text)
    # pick the app straight from the first screen if it is there; otherwise open the full list
    target = fr.get_by_text("PhonePe", exact=True)
    if not target.count():
        for _ in range(5):
            if fr.get_by_text("Payment Options", exact=False).count():
                break
            try:
                fr.get_by_text("More Options", exact=False).first.dispatch_event("click")
            except Exception:
                pass
            time.sleep(2)
        if not fr.get_by_text("PhonePe", exact=True).count():
            fr.get_by_text("UPI ID", exact=False).first.dispatch_event("click")
            time.sleep(2)
        target = fr.get_by_text("PhonePe", exact=True)
    print("PhonePe visible:", target.count() > 0)
    shot(page, "intent_2_apps")
    target.first.dispatch_event("click")
    for _ in range(60):
        banner = page.inner_text("#banner")
        if banner.startswith(("CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REFUND")):
            break
        time.sleep(1)
    print("BANNER:", page.inner_text("#banner"))
    browser.close()
