import type { DeepReadOutput, TriageOutput } from '@hireframe/shared';

/**
 * Deterministic S2 and S3 answers for the emulator's fake transport (ADR-017) and funnel tests,
 * keyed on the posting's title, so `npm run dev` shows every verdict without calling Anthropic:
 * - "Senior …", "Lead …", "Head of …": S2 skip;
 * - product, analyst, onboarding, solutions or implementation titles: S2 pass; S3 apply, unless
 *   the title says "Payments" (a domain gap on a must-have caps fit at 4 → skip) or "Account"
 *   (a missing tool and thin evidence → near miss);
 * - Unity, prompt, creative or game titles: a moderate wildcard match (fit 6.8 → wildcard; a
 *   stronger one would be apply, which comes first in the verdict precedence);
 * - anything else: S2 skip.
 * The deep read cites the first fact aliases in the system prompt.
 */

export function postingTitle(user: string): string {
  return /Title: (.*)/.exec(user)?.[1]?.trim() ?? '';
}

export function fakeTriage(user: string): TriageOutput {
  const title = postingTitle(user);
  if (/\b(senior|lead|head of|principal|director)\b/i.test(title)) {
    return {
      lane: 'none',
      seniority: 'senior',
      blockers: [],
      pass: false,
      triageScore: 1,
      note: 'Too senior.',
    };
  }
  if (/\b(unity|prompt|creative|game)\b/i.test(title)) {
    return {
      lane: 'wildcard',
      seniority: 'junior',
      blockers: [],
      pass: true,
      triageScore: 6,
      note: 'Wildcard interest.',
    };
  }
  if (/\b(product|analyst)\b/i.test(title)) {
    return {
      lane: 'primary',
      seniority: 'junior',
      blockers: [],
      pass: true,
      triageScore: 8,
      note: 'Primary lane fit.',
    };
  }
  if (/\b(onboarding|solutions|implementation|account)\b/i.test(title)) {
    return {
      lane: 'secondary',
      seniority: 'junior',
      blockers: [],
      pass: true,
      triageScore: 7,
      note: 'Customer-facing SaaS role.',
    };
  }
  return {
    lane: 'none',
    seniority: 'unclear',
    blockers: [],
    pass: false,
    triageScore: 2,
    note: 'No lane fits.',
  };
}

export function fakeDeepRead(system: string, user: string): DeepReadOutput {
  const title = postingTitle(user);
  const aliases = [...system.matchAll(/^\[(F\d+)\]/gm)].map((match) => match[1] ?? 'F1');
  const [a = 'F1', b = a, c = b] = aliases;
  const wildcard = /\b(unity|prompt|creative|game)\b/i.test(title);
  const payments = /\bpayments?\b/i.test(title);
  const account = /\baccount\b/i.test(title);
  const requirements: DeepReadOutput['requirements'] = [
    {
      text: 'SQL and product data',
      level: 'must',
      type: 'tool',
      match: 'met',
      gap: null,
      factRefs: [a],
    },
    wildcard
      ? {
          text: 'Shipping Unity projects',
          level: 'must',
          type: 'tool',
          match: 'partial',
          gap: 'tool',
          factRefs: [b],
        }
      : {
          text: 'Working with customers or users',
          level: 'must',
          type: 'skill',
          match: 'met',
          gap: null,
          factRefs: [b],
        },
    {
      text: 'Clear written communication',
      level: 'nice',
      type: 'skill',
      match: 'met',
      gap: null,
      factRefs: [c],
    },
  ];
  if (payments) {
    requirements.push({
      text: 'Commercial payments experience',
      level: 'must',
      type: 'domain',
      match: 'missing',
      gap: 'domain',
      factRefs: [],
    });
  }
  if (account) {
    requirements.push({
      text: 'Salesforce administration',
      level: 'must',
      type: 'tool',
      match: 'missing',
      gap: 'tool',
      factRefs: [],
    });
  }
  const verdict = wildcard ? 'wildcard' : payments ? 'skip' : account ? 'near_miss' : 'apply';
  return {
    requirements,
    rubric: { evidence: account ? 0.5 : wildcard ? 1 : 1.5, companyFit: 0.5 },
    employer: 'small',
    fitScore: payments ? 4 : account ? 6 : 8,
    luckScore: payments ? 4 : account ? 6 : 8,
    verdict,
    reason:
      verdict === 'apply'
        ? 'Strong match on product data work and customer contact.'
        : verdict === 'wildcard'
          ? 'Fits a wildcard interest with relevant projects.'
          : payments
            ? 'Needs commercial payments experience the profile lacks.'
            : 'Close match, but a must-have is missing.',
    talkingPoints: ['Built a SQL dashboard', 'Led client onboarding'],
  };
}
