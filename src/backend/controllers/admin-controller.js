import { authenticateRequest } from "../middlewares/firebase-auth.js";
import { assertRole } from "../middlewares/rbac.js";
import { parsePagination } from "../utils/pagination.js";
import { APP_ROLES } from "../models/types.js";
import { BadRequestError } from "../utils/errors.js";
export class AdminController {
    constructor(authService, adminService) {
        this.authService = authService;
        this.adminService = adminService;
    }
    async listUsers(request) {
        const decoded = await authenticateRequest(request);
        const currentUser = await this.authService.syncUser(decoded);
        assertRole(currentUser.role, ["ADMIN"]);
        const { limit, offset } = parsePagination(request.nextUrl.searchParams);
        const result = await this.adminService.listUsers(limit, offset);
        return {
            users: result.rows,
            pagination: { limit, offset, total: result.total },
        };
    }
    async updateRole(request, userId) {
        const decoded = await authenticateRequest(request);
        const currentUser = await this.authService.syncUser(decoded);
        assertRole(currentUser.role, ["ADMIN"]);
        const body = (await request.json());
        if (!body.role || !APP_ROLES.includes(body.role)) {
            throw new BadRequestError("Invalid role");
        }
        const user = await this.adminService.updateUserRole(userId, body.role);
        return { user };
    }
    async listSalons(request) {
        const decoded = await authenticateRequest(request);
        const currentUser = await this.authService.syncUser(decoded);
        assertRole(currentUser.role, ["ADMIN"]);
        const { limit, offset } = parsePagination(request.nextUrl.searchParams);
        const result = await this.adminService.listSalons(limit, offset);
        return {
            salons: result.rows,
            pagination: { limit, offset, total: result.total },
        };
    }
    async createSalon(request) {
        const decoded = await authenticateRequest(request);
        const currentUser = await this.authService.syncUser(decoded);
        assertRole(currentUser.role, ["ADMIN"]);
        const body = (await request.json());
        const salon = await this.adminService.createSalon({
            name: body.name ?? "",
            address: body.address ?? "",
            pincode: body.pincode ?? "",
            latitude: Number(body.latitude),
            longitude: Number(body.longitude),
            ownerId: body.ownerId ?? currentUser.id,
        });
        return { salon };
    }
    async updateSalon(request, salonId) {
        const decoded = await authenticateRequest(request);
        const currentUser = await this.authService.syncUser(decoded);
        assertRole(currentUser.role, ["ADMIN"]);
        const body = (await request.json());
        const salon = await this.adminService.updateSalon(salonId, {
            name: body.name,
            address: body.address,
            pincode: body.pincode,
            latitude: body.latitude != null ? Number(body.latitude) : undefined,
            longitude: body.longitude != null ? Number(body.longitude) : undefined,
        });
        return { salon };
    }
    async deleteSalon(request, salonId) {
        const decoded = await authenticateRequest(request);
        const currentUser = await this.authService.syncUser(decoded);
        assertRole(currentUser.role, ["ADMIN"]);
        await this.adminService.deleteSalon(salonId);
        return { success: true };
    }
}
