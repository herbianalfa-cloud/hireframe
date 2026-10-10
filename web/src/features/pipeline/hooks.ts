import { useCallback, useEffect, useState } from 'react';
import { useLocation } from 'react-router';

import { isUsable, whenUsable } from '@/lib/perf';

import {
  loadAppliedThisWeek,
  watchApplication,
  watchStage,
  type ApplicationView,
  type PipelineStage,
} from '@/services/applications';
import type { LiveState, Unsubscribe } from '@/services/profile';
import type { Application } from '@hireframe/shared';

function useLive<T>(subscribe: (callback: (state: LiveState<T>) => void) => Unsubscribe) {
  const [state, setState] = useState<LiveState<T>>({ status: 'loading' });
  useEffect(() => subscribe(setState), [subscribe]);
  return state;
}

/** One stage's applications, live (at most `STAGE_PAGE_SIZE`). */
export function useStage(stage: PipelineStage): LiveState<ApplicationView[]> {
  const subscribe = useCallback(
    (callback: (state: LiveState<ApplicationView[]>) => void) => watchStage(stage, callback),
    [stage],
  );
  return useLive(subscribe);
}

/**
 * One job's application, live. Mount it once per job sheet and pass the state down: each call is
 * a listener. `enabled: false` reads nothing and stays `loading` (the sheet waits for
 * `useWhenUsable`).
 */
export function useApplication(jobId: string, enabled = true): LiveState<Application | null> {
  const [state, setState] = useState<LiveState<Application | null>>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return undefined;
    return watchApplication(jobId, setState);
  }, [jobId, enabled]);
  return state;
}

/**
 * True once reads that aren't on the critical path may start (`whenUsable`): after Today marks
 * `hf:usable` when this mounted on Today, at the first idle moment anywhere else.
 */
export function useWhenUsable(): boolean {
  const { pathname } = useLocation();
  const [onToday] = useState(() => pathname === '/');
  const [usable, setUsable] = useState(isUsable);
  useEffect(() => {
    if (usable) return undefined;
    let cancelled = false;
    void whenUsable(onToday).then(() => {
      if (!cancelled) setUsable(true);
    });
    return () => {
      cancelled = true;
    };
  }, [onToday, usable]);
  return usable;
}

/** Applied this week, read once when the screen opens. `null` when it couldn't be read. */
export function useAppliedThisWeek():
  { status: 'loading' } | { status: 'done'; count: number | null } {
  const [state, setState] = useState<
    { status: 'loading' } | { status: 'done'; count: number | null }
  >({ status: 'loading' });
  useEffect(() => {
    let cancelled = false;
    loadAppliedThisWeek(new Date()).then(
      (count) => {
        if (!cancelled) setState({ status: 'done', count });
      },
      () => {
        if (!cancelled) setState({ status: 'done', count: null });
      },
    );
    return () => {
      cancelled = true;
    };
  }, []);
  return state;
}

export interface ActionState {
  pending: boolean;
  error: string | undefined;
  notice: string | undefined;
  /** Runs `call`; the notice (if any) is `describe(result)`. Never throws. */
  run: <T>(
    call: () => Promise<T>,
    options: { fail: (error: unknown) => string; done?: (result: T) => string | undefined },
  ) => Promise<T | undefined>;
  clear: () => void;
}

/** Pending, error and notice for one card's actions. One action at a time. */
export function useAction(): ActionState {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  const run: ActionState['run'] = useCallback(async (call, options) => {
    setPending(true);
    setError(undefined);
    setNotice(undefined);
    try {
      const result = await call();
      setNotice(options.done?.(result));
      return result;
    } catch (caught) {
      setError(options.fail(caught));
      return undefined;
    } finally {
      setPending(false);
    }
  }, []);
  const clear = useCallback(() => {
    setError(undefined);
    setNotice(undefined);
  }, []);
  return { pending, error, notice, run, clear };
}
