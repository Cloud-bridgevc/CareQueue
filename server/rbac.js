// Role-based access control. Every API handler declares the permission it
// needs; nothing is granted implicitly. Caregivers get "own" scopes only.

export const ROLES = {
  admin: 'Operations admin',
  scheduler: 'Scheduler',
  supervisor: 'Supervisor',
  auditor: 'Compliance auditor',
  caregiver: 'Caregiver',
};

const P = {
  admin: [
    'team:read', 'availability:write', 'visits:read', 'visits:write', 'confirmations:write', 'handover:read', 'handover:write',
    'summary:generate', 'summary:approve', 'queue:read', 'queue:update', 'incidents:read', 'incidents:create', 'incidents:manage',
    'reports:read', 'audit:read', 'settings:read', 'settings:write', 'retention:run', 'crm:read', 'demo:run',
  ],
  scheduler: [
    'team:read', 'availability:write', 'visits:read', 'visits:write', 'confirmations:write', 'handover:read', 'handover:write',
    'summary:generate', 'queue:read', 'queue:update', 'incidents:read', 'incidents:create', 'reports:read', 'demo:run',
  ],
  supervisor: [
    'team:read', 'visits:read', 'confirmations:write', 'handover:read', 'handover:write', 'handover:read_restricted',
    'summary:generate', 'summary:approve', 'queue:read', 'queue:update', 'incidents:read', 'incidents:create', 'incidents:manage',
    'reports:read', 'settings:read', 'demo:run',
  ],
  auditor: ['team:read', 'visits:read', 'queue:read', 'incidents:read', 'reports:read', 'audit:read', 'settings:read'],
  caregiver: ['visits:read_own', 'confirmations:write_own', 'handover:read', 'incidents:create'],
};

export const PERMISSIONS = Object.fromEntries(Object.entries(P).map(([r, list]) => [r, new Set(list)]));

export function can(user, permission) {
  return !!user && PERMISSIONS[user.role]?.has(permission);
}

export function permissionsFor(role) {
  return [...(PERMISSIONS[role] || [])];
}

// Handover notes are addressed to roles; restricted notes need an extra grant.
export function canSeeHandover(user, note) {
  if (!can(user, 'handover:read')) return false;
  if (note.restricted && !can(user, 'handover:read_restricted')) return false;
  if (user.role === 'admin') return true;
  return note.audience.includes(user.role);
}
