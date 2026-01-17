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
    const requestId = c.get('requestId') as string | undefined;

    // Structured error logging for Cloudflare
    const errorLog = {
      level: 'error',
      message: error instanceof Error ? error.message : 'Unknown error',
      timestamp: new Date().toISOString(),
      requestId,
      errorCode: error instanceof AppError ? error.code : 'INTERNAL_ERROR',
      errorName: error instanceof Error ? error.name : 'Error',
      stack: error instanceof Error ? error.stack : undefined,
      path: c.req.path,
      method: c.req.method,
    };
    console.error(JSON.stringify(errorLog));

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
