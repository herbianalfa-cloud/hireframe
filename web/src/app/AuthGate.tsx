import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';

import { checkAccess, type Access } from '@/services/access';
import { signInWithGoogle, signOut } from '@/services/auth';

import { startTodayPrefetch } from './lazy-pages';
import { GateErrorScreen, LoadingScreen, NoAccessScreen, SignInScreen } from './GateScreens';
import { SessionContext, useAuthState, type Session } from './session';

/**
 * Renders `children` only for the allowlisted owner (PRD R1, ADR-011). Anyone else
 * sees a sign-in, "No access" or error screen with no navigation and no data.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const auth = useAuthState();
  const queryClient = useQueryClient();
  const [signingIn, setSigningIn] = useState(false);
  const [signInMessage, setSignInMessage] = useState<string | null>(null);

  const uid = auth.status === 'signed-in' ? auth.user.uid : null;
  const access = useQuery<Access>({
    queryKey: ['access', uid],
    queryFn: () => (uid ? checkAccess(uid) : Promise.resolve({ status: 'denied' })),
    enabled: uid !== null,
    staleTime: Infinity,
    retry: false, // checkAccess retries transient errors itself
  });

  // Landing on Today: start its list and its chunk now, in parallel with the owner check
  // (ADR-050). Nothing renders before the check; a non-owner's listener is refused by the
  // rules. The cleanup runs on sign-out (uid goes null) and on unmount.
  const { pathname } = useLocation();
  const pathRef = useRef(pathname);
  useEffect(() => {
    pathRef.current = pathname;
  }, [pathname]);
  useEffect(() => {
    if (uid === null || pathRef.current !== '/') return undefined;
    return startTodayPrefetch();
  }, [uid]);

  const handleSignOut = useCallback(() => {
    queryClient.clear();
    void signOut();
  }, [queryClient]);

  const handleSignIn = useCallback(() => {
    setSigningIn(true);
    setSignInMessage(null);
    void signInWithGoogle().then((result) => {
      setSigningIn(false);
      if (!result.ok) setSignInMessage(result.message);
    });
  }, []);

  const session = useMemo<Session | null>(
    () => (auth.status === 'signed-in' ? { user: auth.user, signOut: handleSignOut } : null),
    [auth, handleSignOut],
  );

  if (auth.status === 'loading') return <LoadingScreen />;
  if (auth.status === 'error') {
    return (
      <GateErrorScreen
        message={auth.message}
        onRetry={() => {
          window.location.reload();
        }}
      />
    );
  }
  if (auth.status === 'signed-out' || !session) {
    return <SignInScreen onSignIn={handleSignIn} busy={signingIn} message={signInMessage} />;
  }

  if (access.isError) {
    return (
      <GateErrorScreen
        message="Couldn't check access. Try again."
        onRetry={() => void access.refetch()}
        onSignOut={handleSignOut}
      />
    );
  }
  if (!access.data) return <LoadingScreen />;
  switch (access.data.status) {
    case 'denied':
      return <NoAccessScreen email={session.user.email} onSignOut={handleSignOut} />;
    case 'error':
      return (
        <GateErrorScreen
          message={access.data.message}
          onRetry={() => void access.refetch()}
          onSignOut={handleSignOut}
        />
      );
    case 'owner':
      return <SessionContext value={session}>{children}</SessionContext>;
  }
}
