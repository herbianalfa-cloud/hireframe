import { LoaderCircle, LockKeyhole, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';

import { Button } from '@/components/ui/button';

function Centered({ children }: { children: ReactNode }) {
  return (
    <main className="grid min-h-dvh place-items-center bg-background px-4">
      <div className="w-full max-w-sm rounded-lg border bg-surface p-6 text-center">{children}</div>
    </main>
  );
}

function Brand() {
  return (
    <p className="mb-6 font-mono text-xs tracking-widest text-muted-foreground uppercase">
      Hireframe
    </p>
  );
}

export function LoadingScreen() {
  return (
    <main className="grid min-h-dvh place-items-center bg-background" aria-busy="true">
      <LoaderCircle aria-hidden="true" className="size-6 animate-spin text-muted-foreground" />
      <span className="sr-only">Loading</span>
    </main>
  );
}

export function SignInScreen({
  onSignIn,
  busy,
  message,
}: {
  onSignIn: () => void;
  busy: boolean;
  message: string | null;
}) {
  return (
    <Centered>
      <Brand />
      <h1 className="text-lg font-semibold">Sign in</h1>
      <p className="mt-1 text-sm text-muted-foreground">Private workspace. Owner access only.</p>
      <Button className="mt-6 w-full" onClick={onSignIn} disabled={busy}>
        {busy ? <LoaderCircle aria-hidden="true" className="animate-spin" /> : null}
        Sign in with Google
      </Button>
      {message ? (
        <p role="alert" className="mt-4 text-sm text-danger">
          {message}
        </p>
      ) : null}
    </Centered>
  );
}

export function NoAccessScreen({
  email,
  onSignOut,
}: {
  email: string | null;
  onSignOut: () => void;
}) {
  return (
    <Centered>
      <Brand />
      <LockKeyhole aria-hidden="true" className="mx-auto size-6 text-muted-foreground" />
      <h1 className="mt-3 text-lg font-semibold">No access</h1>
      <p className="mt-1 text-sm text-muted-foreground">
        This account doesn&apos;t have access to Hireframe.
      </p>
      {email ? (
        <p className="mt-3 font-mono text-xs text-muted-foreground">Signed in as {email}</p>
      ) : null}
      <Button variant="secondary" className="mt-6 w-full" onClick={onSignOut}>
        Sign out
      </Button>
    </Centered>
  );
}

export function GateErrorScreen({
  message,
  onRetry,
  onSignOut,
}: {
  message: string;
  onRetry: () => void;
  onSignOut?: () => void;
}) {
  return (
    <Centered>
      <Brand />
      <TriangleAlert aria-hidden="true" className="mx-auto size-6 text-danger" />
      <h1 className="mt-3 text-lg font-semibold">Something went wrong</h1>
      <p role="alert" className="mt-1 text-sm text-muted-foreground">
        {message}
      </p>
      <div className="mt-6 flex gap-2">
        <Button className="flex-1" onClick={onRetry}>
          Try again
        </Button>
        {onSignOut ? (
          <Button variant="secondary" className="flex-1" onClick={onSignOut}>
            Sign out
          </Button>
        ) : null}
      </div>
    </Centered>
  );
}
