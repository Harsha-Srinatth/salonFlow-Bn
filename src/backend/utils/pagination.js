export function parsePagination(searchParams) {
    const limitRaw = Number(searchParams.get("limit") ?? 25);
    const offsetRaw = Number(searchParams.get("offset") ?? 0);
    const limit = Number.isFinite(limitRaw) ? Math.min(Math.max(limitRaw, 1), 100) : 25;
    const offset = Number.isFinite(offsetRaw) ? Math.max(offsetRaw, 0) : 0;
    return { limit, offset };
}
