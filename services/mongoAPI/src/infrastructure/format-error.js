// ============================================================
// FORMATO DE ERRORES HACIA EL CLIENTE (formatError de Apollo)
//
// Un solo lugar para que todo error de negocio llegue con `extensions.code`
// estable (ver domain/errors.js). Sin dependencias de servicios: se puede
// probar sin bases de datos.
//
//   DomainError          -> su code y sus detalles (lo lanzó una regla)
//   ValidationError      -> VALIDATION_ERROR { field, violations: [{ field, rule }] }
//                           `rule` es el código de dominio si el hook de Mongoose
//                           lo propagó (p. ej. INVALID_PRICE) o el tipo de Mongoose
//                           (required, min, enum, ...).
//   E11000 (clave única) -> EMAIL_ALREADY_REGISTERED o DUPLICATE_VALUE { field }
//   Neo4j caído          -> SERVICE_UNAVAILABLE { service: 'RBAC' }
//   cualquier otro       -> sin cambios (GraphQLError con su código, o Apollo)
// ============================================================

import { DomainError, isErrorCode } from '../domain/errors.js';

const DUPLICATE_MESSAGE = field => `Ya existe un registro con ese valor en "${field}".`;

export function formatApiError(formatted, error) {
  const original = error?.originalError ?? error;

  if (original instanceof DomainError) {
    // extensions lleva el código (PRICE_CHANGED, CART_EMPTY…) y sus detalles (newQuote, unavailable…).
    return { message: original.message, path: formatted.path, extensions: original.extensions };
  }

  if (original?.name === 'ValidationError') {
    const entries = Object.values(original.errors ?? {});
    const detail = entries.map(e => e.message).join(' ') || original.message;
    const violations = entries.map(e => ({
      field: e.path ?? null,
      rule: isErrorCode(e.kind) ? e.kind : (e.kind ?? e.name ?? 'invalid'),
    }));
    return {
      message: detail,
      path: formatted.path,
      extensions: { code: 'VALIDATION_ERROR', field: violations[0]?.field ?? null, violations },
    };
  }

  // Clave única duplicada (el correo del usuario, el nombre de categoría…).
  if (original?.code === 11000) {
    const field = Object.keys(original.keyPattern ?? {})[0] ?? null;
    if (field === 'email') {
      return { message: 'Ya existe un usuario con ese correo.', path: formatted.path, extensions: { code: 'EMAIL_ALREADY_REGISTERED', field } };
    }
    return { message: DUPLICATE_MESSAGE(field ?? '?'), path: formatted.path, extensions: { code: 'DUPLICATE_VALUE', field } };
  }

  // Neo4j (roles) sin respuesta a mitad de una operación: sin esto llegaría como INTERNAL_SERVER_ERROR.
  if (original?.code === 'ServiceUnavailable' || original?.code === 'SessionExpired') {
    return { message: original.message, path: formatted.path, extensions: { code: 'SERVICE_UNAVAILABLE', service: 'RBAC' } };
  }

  return formatted;
}
