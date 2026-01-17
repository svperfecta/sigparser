import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../types/constants.js';
import type { PaginationParams } from '../types/index.js';

export interface ParsedPagination {
  page: number;
  limit: number;
  offset: number;
  sort: string;
  order: 'ASC' | 'DESC';
}

/**
 * Parse and validate pagination parameters from query string
 */
export function parsePagination(
  query: Record<string, string | undefined>,
  defaultSort = 'created_at',
  allowedSorts: string[] = ['created_at'],
): ParsedPagination {
  // Parse page number
  let page = 1;
  if (query.page !== undefined) {
    const parsed = parseInt(query.page, 10);
    if (!isNaN(parsed) && parsed > 0) {
      page = parsed;
    }
  }

  // Parse limit
  let limit = DEFAULT_PAGE_SIZE;
  if (query.limit !== undefined) {
    const parsed = parseInt(query.limit, 10);
    if (!isNaN(parsed) && parsed > 0) {
      limit = Math.min(parsed, MAX_PAGE_SIZE);
    }
  }

  // Parse sort field
  let sort = defaultSort;
  if (query.sort !== undefined && allowedSorts.includes(query.sort)) {
    sort = query.sort;
  }

  // Parse order
  let order: 'ASC' | 'DESC' = 'DESC';
  if (query.order !== undefined) {
    const orderLower = query.order.toLowerCase();
    if (orderLower === 'asc') {
      order = 'ASC';
    }
  }

  const offset = (page - 1) * limit;

  return { page, limit, offset, sort, order };
}

/**
 * Create pagination response metadata
 */
export function paginationMeta(
  page: number,
  limit: number,
  total: number,
): PaginationParams & { total: number; totalPages: number } {
  return {
    page,
    limit,
    total,
    totalPages: Math.ceil(total / limit),
  };
}
