export function getRequestId(request) {
    return request.headers.get("x-request-id") ?? crypto.randomUUID();
}
export function logApiEvent(input) {
    const payload = {
        level: input.statusCode >= 500 ? "error" : "info",
        ts: new Date().toISOString(),
        requestId: input.requestId,
        path: input.path,
        method: input.method,
        statusCode: input.statusCode,
        durationMs: input.durationMs,
        message: input.message,
    };
    const line = JSON.stringify(payload);
    if (input.statusCode >= 500) {
        console.error(line);
    }
    else {
        console.log(line);
    }
}
