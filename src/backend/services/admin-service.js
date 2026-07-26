import { APP_ROLES } from "../models/types.js";
import { BadRequestError } from "../utils/errors.js";
export class AdminService {
    constructor(userRepository, salonRepository) {
        this.userRepository = userRepository;
        this.salonRepository = salonRepository;
    }
    async listUsers(limit, offset) {
        return this.userRepository.listPaginated(limit, offset);
    }
    async updateUserRole(userId, role) {
        if (!APP_ROLES.includes(role))
            throw new BadRequestError("Invalid role");
        const updated = await this.userRepository.updateRole(userId, role);
        if (!updated)
            throw new BadRequestError("User not found");
        return updated;
    }
    async listSalons(limit, offset) {
        return this.salonRepository.listPaginated(limit, offset);
    }
    async createSalon(data) {
        if (!data.name ||
            !data.address ||
            !data.pincode ||
            !Number.isFinite(data.latitude) ||
            !Number.isFinite(data.longitude)) {
            throw new BadRequestError("Missing required fields");
        }
        return this.salonRepository.create(data);
    }
    async updateSalon(id, data) {
        const updated = await this.salonRepository.update(id, data);
        if (!updated)
            throw new BadRequestError("Salon not found");
        return updated;
    }
    async deleteSalon(id) {
        const deleted = await this.salonRepository.remove(id);
        if (!deleted)
            throw new BadRequestError("Salon not found");
        return deleted;
    }
}
