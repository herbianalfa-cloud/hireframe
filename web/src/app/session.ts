import { createContext, useContext, useEffect, useState } from 'react';

import { onAuthChange, type AuthState, type AuthUser } from '@/services/auth';

export function useAuthState(): AuthState {
  const [state, setState] = useState<AuthState>({ status: 'loading' });
  useEffect(() => onAuthChange(setState), []);
  return state;
}

export interface Session {
  user: AuthUser;
  signOut: () => void;
}

export const SessionContext = createContext<Session | null>(null);

/** The signed-in owner's session. Only rendered inside AuthGate's owner branch. */
export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession must be used inside AuthGate');
  return session;
}
