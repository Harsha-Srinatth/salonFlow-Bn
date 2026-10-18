// Public status page (Lambda function URL): checks the API's /ready probe and renders the result.
const API_READY_URL = process.env.API_READY_URL ?? "https://api.sahasrafamilysalon.in/ready"

export const handler = async () => {
  const started = Date.now()
  let ok = false
  let detail = ""
  try {
    const res = await fetch(API_READY_URL, { signal: AbortSignal.timeout(5000) })
    ok = res.ok
    detail = `HTTP ${res.status}`
  } catch (error) {
    detail = error instanceof Error ? error.name : "error"
  }
  const ms = Date.now() - started
  const color = ok ? "#1a7f37" : "#cf222e"
  const label = ok ? "All systems operational" : "API unavailable"

  return {
    statusCode: ok ? 200 : 503,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
    body: `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>Sahasra Status</title>
<style>body{font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;padding:0 1rem;color:#1f2328}
.dot{display:inline-block;width:.75rem;height:.75rem;border-radius:50%;background:${color};margin-right:.5rem}
small{color:#656d76}</style></head><body>
<h1>Sahasra Family Salon</h1><p><span class="dot"></span><strong>${label}</strong></p>
<small>${detail} · ${ms} ms · checked ${new Date().toISOString()}</small></body></html>`,
  }
}
