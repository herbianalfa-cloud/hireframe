import { useEffect, useState } from 'react';

import { watchTodoCount, type TodoCount } from '@/services/pipeline-todo';

/**
 * The pipeline's to-do count, live. Pass `enabled: false` until the app is usable (`hf:usable`):
 * nothing is read while it is false, and the state stays `loading` (a skeleton).
 */
export function useTodoCount(enabled: boolean): TodoCount {
  const [state, setState] = useState<TodoCount>({ status: 'loading' });
  useEffect(() => {
    if (!enabled) return undefined;
    return watchTodoCount(setState);
  }, [enabled]);
  return state;
}
