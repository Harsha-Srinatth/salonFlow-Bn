import { NextResponse } from "next/server";
import { AppError } from "./errors.js";
import { getRequestId, logApiEvent } from "./observability.js";
export async function withErrorHandler(request, handler) {
    const startedAt = Date.now();
    const requestId = getRequestId(request);
    try {
        const data = await handler();
        const response = NextResponse.json(data);
        response.headers.set("x-request-id", requestId);
        logApiEvent({
            requestId,
            path: request.nextUrl.pathname,
            method: request.method,
            statusCode: 200,
            durationMs: Date.now() - startedAt,
        });
        return response;
    }
    catch (error) {
        if (error instanceof AppError) {
            const response = NextResponse.json({ error: error.message, requestId }, { status: error.statusCode });
            response.headers.set("x-request-id", requestId);
            logApiEvent({
                requestId,
                path: request.nextUrl.pathname,
                method: request.method,
                statusCode: error.statusCode,
                durationMs: Date.now() - startedAt,
                message: error.message,
            });
            return response;
        }
        const response = NextResponse.json({ error: "Internal server error", requestId }, { status: 500 });
        response.headers.set("x-request-id", requestId);
        logApiEvent({
            requestId,
            path: request.nextUrl.pathname,
            method: request.method,
            statusCode: 500,
            durationMs: Date.now() - startedAt,
            message: error instanceof Error ? error.message : "Unknown error",
        });
        return response;
    }
}
