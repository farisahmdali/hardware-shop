import { createContext, useContext, type ReactNode } from 'react';
import type { SessionInfo } from '@shared/contracts';
import type { Permission } from '@shared/permissions';

const SessionContext = createContext<SessionInfo | null>(null);

export function SessionProvider({ session, children }: { session: SessionInfo; children: ReactNode }) {
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): SessionInfo {
  const s = useContext(SessionContext);
  if (!s) throw new Error('useSession used outside a signed-in area');
  return s;
}

/** Mirrors the main process rule for who may see purchase costs and stock value. */
export function useCanSeeCost(): boolean {
  const s = useSession();
  return (['products.manage', 'stock.adjust', 'reports.financial'] as Permission[]).some((p) => s.permissions.includes(p));
}

/** For hiding controls the user cannot use. The main process enforces permissions regardless. */
export function useCan(): (permission: Permission) => boolean {
  const s = useSession();
  return (permission) => s.permissions.includes(permission);
}
