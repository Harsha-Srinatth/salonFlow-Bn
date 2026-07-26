export class AppError extends Error {
    constructor(message, statusCode = 500) {
        super(message);
        this.statusCode = statusCode;
    }
}
export class UnauthorizedError extends AppError {
    constructor(message = "Unauthorized") {
        super(message, 401);
    }
}
export class ForbiddenError extends AppError {
    constructor(message = "Forbidden") {
        super(message, 403);
    }
}
export class BadRequestError extends AppError {
    constructor(message = "Bad request") {
        super(message, 400);
    }
}
export class ConflictError extends AppError {
    constructor(message = "Conflict") {
        super(message, 409);
    }
}
