"""
Drives the REAL Razorpay Checkout (test mode) through the harness with Playwright.
usage: python scripts/pw_checkout.py success|failure|dismiss
Needs: backend on :18081 and `node scripts/checkout-harness-server.mjs` on :5173.
"""
import sys, time, json
from playwright.sync_api import sync_playwright

def shot(pg, path):
    try:
        pg.screenshot(path=path, timeout=8000)
    except Exception:
        pass


scenario = sys.argv[1] if len(sys.argv) > 1 else "success"
flags = sys.argv[2:]  # drop = drop the verify call, delay = delay it 10s
OUT = "scripts/.out"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    page = browser.new_page(viewport={"width": 1100, "height": 800})
    page.on("console", lambda m: None)
    page.goto("http://localhost:5173/")
    page.click("#setup")
    page.wait_for_function("document.querySelectorAll('#slot option').length > 0")
    # pick a distinct slot per scenario so they never collide
    idx = {"success": 5, "failure": 8, "dismiss": 12}[scenario]
    if "slot" in "".join(flags):
        idx = int([f for f in flags if f.startswith("slot")][0][4:])
    if "drop" in flags:
        page.check("#dropVerify")
    if "delay" in flags:
        page.check("#delayVerify")
    if "today" in flags:
        page.select_option("#day", "0")
        page.wait_for_timeout(2500)
    if "last" in flags:
        idx = page.evaluate("document.querySelectorAll('#slot option').length") - 1
    page.select_option("#slot", str(idx))
    page.click("#pay")
    frame_el = page.wait_for_selector("iframe.razorpay-checkout-frame", timeout=30000)
    fr = page.frame_locator("iframe.razorpay-checkout-frame")
    time.sleep(4)
    shot(page, f"{OUT}/{scenario}_1_checkout.png")
    if scenario == "dismiss":
        fr.locator("[data-testid='close'], button[aria-label='Close'], #modal-close, .close").first.click(timeout=5000) if False else None
        try:
            fr.get_by_role("button", name="Close").first.click(timeout=5000)
        except Exception:
            page.keyboard.press("Escape")
        # confirm-close dialog
        time.sleep(1.5)
        shot(page, f"{OUT}/{scenario}_2_closing.png")
        for label in ("Yes, cancel", "Yes", "Cancel payment"):
            try:
                fr.get_by_text(label, exact=False).first.click(timeout=2000)
                break
            except Exception:
                pass
    else:
        for _ in range(6):
            fr.get_by_text("Cards", exact=True).first.dispatch_event("click")
            time.sleep(2)
            if fr.locator("input[name='card.number'], #card_number, input[placeholder*='Card Number' i]").count():
                break
        time.sleep(1)
        fr.locator("input[name='card.number'], #card_number, input[placeholder*='Card Number' i]").first.fill("5267 3181 8797 5449")
        fr.locator("input[name='card.expiry'], #card_expiry, input[placeholder*='MM' i]").first.fill("12/30")
        fr.locator("input[name='card.cvv'], #card_cvv, input[placeholder*='CVV' i]").first.fill("123")
        shot(page, f"{OUT}/{scenario}_2_card.png")
        time.sleep(1)
        fr.locator("button:has-text('Continue'), [role=button]:has-text('Continue')").first.dispatch_event("click")
        time.sleep(3)
        try:
            fr.get_by_text("Maybe later", exact=True).first.click(timeout=4000)
        except Exception:
            pass
        time.sleep(6)
        shot(page, f"{OUT}/{scenario}_3_after_pay.png")
        # OTP step -> "Pay on bank's page" opens Razorpay's mock bank with Success / Failure buttons
        label = "Success" if scenario == "success" else "Failure"
        time.sleep(5)
        for _ in range(40):  # wait for the OTP step; dismiss the "save card" prompt if it appears
            if fr.get_by_text("Pay on bank's page", exact=False).count():
                break
            if fr.get_by_text("Maybe later", exact=True).count():
                fr.get_by_text("Maybe later", exact=True).first.dispatch_event("click")
            time.sleep(1)
        print("STATE:", " | ".join(fr.locator("body").inner_text().split()[:12]))
        with page.context.expect_page(timeout=30000) as popup_info:
            fr.get_by_text("Pay on bank's page", exact=False).first.dispatch_event("click")
        bank = popup_info.value
        bank.wait_for_load_state("domcontentloaded")
        time.sleep(3)
        try:
            bank.screenshot(path=f"{OUT}/{scenario}_4_bank.png", timeout=8000)
        except Exception:
            pass
        bank.get_by_text(label, exact=True).first.click(timeout=15000)
        print("clicked bank", label)
    # wait for the banner to reach a final state
    for _ in range(60):
        txt = page.inner_text("#banner")
        if any(txt.startswith(s) for s in ("CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REFUND", "could not")):
            break
        time.sleep(1)
    time.sleep(1)
    shot(page, f"{OUT}/{scenario}_5_final.png")
    print("BANNER:", page.inner_text("#banner"))
    if "cancel" in flags:
        page.click("#cancelBooking")
        page.wait_for_function("window.__cancel", timeout=30000)
        print("CANCEL:", json.dumps(page.evaluate("window.__cancel"))[:700])
    print("LOG TAIL:", page.inner_text("#log")[-700:])
    browser.close()
