import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useMemo, useState, type ReactNode } from 'react';

import { checkAccess, type Access } from '@/services/access';
import { signInWithGoogle, signOut } from '@/services/auth';

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
