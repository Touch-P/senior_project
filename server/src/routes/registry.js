import { requireRole } from '../auth/middleware.js';

/** Every admin-only route as "METHOD /full/path"; tests assert staff gets 403 on each one. */
export const adminOnlyRoutes = new Set();

/**
 * Wrap an Express router mounted at `base` so admin-only routes are registered in one place.
 * @param {import('express').Router} router
 * @param {string} base mount path, e.g. /api/admin
 */
export function routes(router, base) {
  const add = (method, path, handlers) => router[method](path, ...handlers);
  return {
    /** Any authenticated role allowed by the router's own middleware. */
    get: (path, ...h) => add('get', path, h),
    post: (path, ...h) => add('post', path, h),
    put: (path, ...h) => add('put', path, h),
    patch: (path, ...h) => add('patch', path, h),
    delete: (path, ...h) => add('delete', path, h),
    /** Admin role only (staff -> 403). */
    admin(method, path, ...h) {
      adminOnlyRoutes.add(`${method.toUpperCase()} ${base}${path}`);
      add(method.toLowerCase(), path, [requireRole('admin'), ...h]);
    },
  };
}
