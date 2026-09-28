import type { ExecutionPolicy } from '@/types/desktop';

export function executionLabel(leg: 'source' | 'target', policy?: ExecutionPolicy, legacyActive = false) {
  const role = leg === 'source' ? 'Исходная' : 'Целевая';
  if (!policy) return legacyActive ? `${role} · ${leg === 'source' ? 'MARKET' : 'LIMIT'}` : role;
  return `${role} · ${leg === 'source' ? policy.sourcePostOnly ? 'POST-ONLY' : 'LIMIT' : policy.targetPostOnly ? 'POST / MARKET' : 'MARKET'}`;
}
