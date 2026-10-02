"""
Real Razorpay Checkout, UPI (test mode). usage: python scripts/pw_upi.py success|failure [slotN] [cancel] [explore]
Razorpay's published test VPAs: success@razorpay -> payment succeeds, failure@razorpay -> payment fails.
"""
import sys, time, json
from playwright.sync_api import sync_playwright

def shot(pg, path):
    try:
        pg.screenshot(path=path, timeout=8000)
    except Exception:
        pass


scenario = sys.argv[1] if len(sys.argv) > 1 else "success"
flags = sys.argv[2:]
OUT = "scripts/.out"
vpa = "success@razorpay" if scenario == "success" else "failure@razorpay"

with sync_playwright() as p:
    browser = p.chromium.launch(headless=False)
    # a phone-sized viewport makes Checkout offer the UPI ID field instead of only the desktop QR
    ctx = browser.new_context(**p.devices["Pixel 7"])
    page = ctx.new_page()
    page.goto("http://localhost:5173/")
    page.click("#setup")
    page.wait_for_function("document.querySelectorAll('#slot option').length > 0")
    idx = 30
    for f in flags:
        if f.startswith("slot"):
            idx = int(f[4:])
    page.select_option("#slot", str(idx))
    page.click("#pay")
    page.wait_for_selector("iframe.razorpay-checkout-frame", timeout=30000)
    fr = page.frame_locator("iframe.razorpay-checkout-frame")
    time.sleep(5)
    shot(page, path=f"{OUT}/upi_{scenario}_1.png")
    def body():
        return fr.locator("body").inner_text()
    for _ in range(6):  # the bottom sheet animates; retry until the full options list is showing
        if "Payment Options" in body():
            break
        try:
            fr.get_by_text("More Options", exact=False).first.dispatch_event("click")
        except Exception:
            pass
        time.sleep(2)
    if "UPI ID" not in body():
        fr.get_by_text("UPI", exact=True).last.dispatch_event("click")
        time.sleep(2)
    print("options:", " | ".join(body().split()[:45]))
    fr.get_by_text("UPI ID", exact=False).first.dispatch_event("click")
    time.sleep(2)
    shot(page, f"{OUT}/upi_{scenario}_2.png")
    print("after UPI ID click:", " | ".join(body().split()[:50]))
    for name in ("PhonePe",):
        try:
            fr.get_by_text(name, exact=True).first.dispatch_event("click")
            time.sleep(2)
            print("after", name, ":", " | ".join(body().split()[:60])); shot(page, f"{OUT}/upi_{scenario}_app.png"); print("pages:", [pg.url[:70] for pg in ctx.pages])
        except Exception as e:
            print("click", name, "failed", str(e)[:60])
    print("inputs:", fr.locator("input").evaluate_all("els => els.map(e => [e.name, e.placeholder, e.type]).filter(x => x[2] !== 'radio')"))
    for name in ("PhonePe",):
        fr.get_by_text(name, exact=True).first.dispatch_event("click")
    if "explore" in flags:
        pass
    # intent flow: the customer picks an app; the payment then waits for approval inside that app
    for t in range(6):
        time.sleep(10)
        print(f"t+{(t+1)*10}s banner:", page.inner_text("#banner")[:80])
        if page.inner_text("#banner").startswith(("CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REFUND")):
            break
    for _ in range(90):
        txt = page.inner_text("#banner")
        if any(txt.startswith(s) for s in ("CONFIRMED", "FAILED", "CANCELLED", "EXPIRED", "REFUND", "could not")):
            break
        time.sleep(1)
    time.sleep(1)
    shot(page, path=f"{OUT}/upi_{scenario}_4.png")
    print("BANNER:", page.inner_text("#banner"))
    if "cancel" in flags:
        page.click("#cancelBooking")
        page.wait_for_function("window.__cancel", timeout=30000)
        print("CANCEL:", json.dumps(page.evaluate("window.__cancel")["data"].get("refund")))
    browser.close()
