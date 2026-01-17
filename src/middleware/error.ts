import type { Context, Next } from 'hono';
import type { ApiError } from '../types/index.js';

export class AppError extends Error {
  constructor(
    message: string,
    public code: string,
    public status = 500,
    public details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export class NotFoundError extends AppError {
  constructor(resource: string) {
    super(`${resource} not found`, 'NOT_FOUND', 404);
  }
}

export class ValidationError extends AppError {
  constructor(details: Record<string, string>) {
    super('Validation failed', 'VALIDATION_ERROR', 400, details);
  }
}

export class UnauthorizedError extends AppError {
  constructor(message = 'Unauthorized') {
    super(message, 'UNAUTHORIZED', 401);
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden') {
    super(message, 'FORBIDDEN', 403);
  }
}

export async function errorHandler(c: Context, next: Next): Promise<Response> {
  try {
    await next();
  } catch (error) {
    console.error('Unhandled error:', error);

    if (error instanceof AppError) {
      const body: ApiError = {
        error: error.message,
        code: error.code,
      };
      if (error.details !== undefined) {
        body.details = error.details;
      }
      return c.json(body, error.status as 400 | 401 | 403 | 404 | 500);
    }

    return c.json<ApiError>(
      {
        error: 'An unexpected error occurred',
        code: 'INTERNAL_ERROR',
      },
      500,
    );
  }
  // This return is needed for TypeScript but won't be reached
  // since next() will return a response
  return c.json<ApiError>({ error: 'No response', code: 'INTERNAL_ERROR' }, 500);
}
