// ============================================================
// Telemetría de seguridad: los cuatro eventos de la cola "eventos-seguridad"
//   LOGIN_FAILED, LOGIN_SUCCESS, USER_REGISTERED, ROLE_CHANGED
//
// Cada fábrica recibe solo lo que el evento necesita y devuelve el argumento de
// emitEvent. Ninguna recibe la contraseña, el hash, el JWT ni el refresh token
// (CWE-532): lo que no entra aquí no puede acabar en la cola ni en los logs.
// auth.js e index.js emiten con estas fábricas; las pruebas arman los mismos eventos.
// ============================================================

import { CATEGORIES } from './events.js';

// Largo máximo de un correo (RFC 5321). El login rechaza lo más largo antes de buscarlo (auth.js).
export const MAX_EMAIL_LENGTH = 320;

// El correo que quedó escrito en el intento de login. Un valor sin '@' no es un correo (suele ser una
// contraseña escrita en el campo equivocado): no se guarda. Los correos normales van tal cual.
const loggedEmail = email => {
  const text = String(email ?? '').slice(0, MAX_EMAIL_LENGTH);
  return text.includes('@') ? text : '[invalid-email]';
};

// Intento de login rechazado. Mismo error para el cliente en los tres casos; el motivo real queda
// en la bitácora. `reason` es un texto fijo: nunca incluye lo que el usuario escribió.
export function loginFailedEvent({ user, valid, email }) {
  return {
    type: 'LOGIN_FAILED', category: CATEGORIES.SECURITY, success: false,
    actorId: user?._id ?? 'ANONYMOUS', actorRole: user?.role ?? null,
    reason: !user ? 'Correo no registrado' : !valid ? 'Contraseña incorrecta' : 'Cuenta desactivada',
    metadata: { email: loggedEmail(email) },
  };
}

export function loginSuccessEvent({ userId, access, jti, familyId }) {
  return {
    type: 'LOGIN_SUCCESS', category: CATEGORIES.SECURITY, actorId: userId, actorRole: access.role,
    reason: access.degraded ? 'Sesión sin permisos (Neo4j no disponible)' : 'Autenticación correcta',
    metadata: { jti, familyId, permissions: access.permissions.length, stores: access.storeIds.length },
  };
}

// `admin` es el usuario autenticado que hizo el alta (null en el registro abierto).
export function userRegisteredEvent({ user, role, admin = null }) {
  return {
    type: 'USER_REGISTERED', category: CATEGORIES.ADMIN,
    actorId: admin?.id ?? user._id, actorRole: admin?.role ?? role,
    targetType: 'User', targetId: user._id,
    reason: admin ? 'Alta hecha por un administrador' : 'Registro abierto',
    metadata: { email: user.email, role },
  };
}

// Lo completa afterAccessChange (auth.js) con el objetivo (targetType 'User', targetId).
export function roleChangedEvent({ previous, role }) {
  return {
    type: 'ROLE_CHANGED', category: CATEGORIES.ADMIN,
    reason: `Rol ${previous ?? '—'} → ${role}`, metadata: { from: previous, to: role },
  };
}
