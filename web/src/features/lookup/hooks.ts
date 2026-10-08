import { useEffect, useState } from 'react';

import type { JobView } from '@/services/jobs';
import { watchWaitingJobs } from '@/services/lookup';
import type { LiveState } from '@/services/profile';

export function useWaitingJobs(pageSize: number): LiveState<JobView[]> {
  const [state, setState] = useState<LiveState<JobView[]>>({ status: 'loading' });
  useEffect(() => watchWaitingJobs(pageSize, setState), [pageSize]);
  return state;
}
