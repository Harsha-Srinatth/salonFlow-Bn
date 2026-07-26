import { BadRequestError } from "../utils/errors.js";
export class AuthService {
    constructor(userRepository) {
        this.userRepository = userRepository;
    }
    async syncUser(decoded, options) {
        if (!decoded.uid) {
            throw new BadRequestError("Token missing required claims");
        }
        const existing = await this.userRepository.findByFirebaseUid(decoded.uid);
        const phoneFromToken = typeof decoded.phone_number === "string" && decoded.phone_number.length > 0
            ? decoded.phone_number
            : undefined;
        const phoneToPersist = options?.requestedPhone ?? phoneFromToken;
        if (existing) {
            if (phoneToPersist && existing.phone !== phoneToPersist) {
                await this.userRepository.updatePhone(existing.id, phoneToPersist);
                const refreshed = await this.userRepository.findByFirebaseUid(decoded.uid);
                if (refreshed)
                    return refreshed;
            }
            return existing;
        }
        const requestedRole = options?.requestedRole;
        const roleToCreate = requestedRole === "ADMIN" ? "ADMIN" : "USER";
        if (!phoneToPersist) {
            throw new BadRequestError("Phone number is required for signup");
        }
        const resolvedEmail = typeof decoded.email === "string" && decoded.email.length > 0
            ? decoded.email
            : `${decoded.uid}@phone.local`;
        return this.userRepository.createFromFirebase({
            firebaseUid: decoded.uid,
            email: resolvedEmail,
            name: decoded.name ?? resolvedEmail.split("@")[0],
            role: roleToCreate,
            phone: phoneToPersist,
        });
    }
}
