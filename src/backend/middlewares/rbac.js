import { ForbiddenError } from "../utils/errors.js";
export function assertRole(role, allowed) {
    if (!allowed.includes(role)) {
        throw new ForbiddenError("Insufficient role");
    }
}
