import { authenticateRequest } from "../middlewares/firebase-auth.js";
import { assertRole } from "../middlewares/rbac.js";
import { parsePagination } from "../utils/pagination.js";
import { createStaffBodySchema, updateStaffBodySchema } from "../utils/staff-schemas.js";
import { BadRequestError } from "../utils/errors.js";
function sanitizeStaff(row) {
    const { passwordHash: _p, ...rest } = row;
    return rest;
}
export class StaffAdminController {
    constructor(authService, staffAdminService) {
        this.authService = authService;
        this.staffAdminService = staffAdminService;
    }
    async requireAdmin(request) {
        const decoded = await authenticateRequest(request);
        const currentUser = await this.authService.syncUser(decoded);
        assertRole(currentUser.role, ["ADMIN"]);
        return currentUser;
    }
    async list(request) {
        await this.requireAdmin(request);
        const { limit, offset } = parsePagination(request.nextUrl.searchParams);
        const result = await this.staffAdminService.listStaff(limit, offset);
        return {
            staff: result.rows.map(sanitizeStaff),
            pagination: { limit, offset, total: result.total },
        };
    }
    async create(request) {
        await this.requireAdmin(request);
        const parsed = createStaffBodySchema.safeParse(await request.json());
        if (!parsed.success) {
            throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid body");
        }
        const result = await this.staffAdminService.createStaff(parsed.data);
        return {
            staff: sanitizeStaff(result.staff),
            message: result.message,
        };
    }
    async update(request, id) {
        await this.requireAdmin(request);
        const parsed = updateStaffBodySchema.safeParse(await request.json());
        if (!parsed.success) {
            throw new BadRequestError(parsed.error.issues[0]?.message ?? "Invalid body");
        }
        const result = await this.staffAdminService.updateStaff(id, parsed.data);
        return {
            staff: sanitizeStaff(result.staff),
        };
    }
    async remove(request, id) {
        await this.requireAdmin(request);
        return this.staffAdminService.deleteStaff(id);
    }
}
