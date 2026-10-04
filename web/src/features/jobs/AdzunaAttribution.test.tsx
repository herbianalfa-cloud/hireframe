import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AdzunaAttribution, SourceAttribution } from './AdzunaAttribution';
import { makeJob } from './fixtures';

describe('attribution (ADR-025)', () => {
  it('links the self-hosted Adzuna logo to adzuna.co.uk at the required size', () => {
    render(<AdzunaAttribution />);
    const link = screen.getByRole('link', { name: /jobs by adzuna/i });
    expect(link.getAttribute('href')).toBe('https://www.adzuna.co.uk');
    expect(link.getAttribute('rel')).toContain('noopener');
    const logo = screen.getByRole('img', { name: 'Adzuna' });
    expect(logo.getAttribute('src')).toBe('/attribution/adzuna-logo.png');
    expect(Number(logo.getAttribute('width'))).toBeGreaterThanOrEqual(116);
    expect(Number(logo.getAttribute('height'))).toBeGreaterThanOrEqual(23);
  });

  it('shows Adzuna for any job it was found by, and "via Reed" with its own link', () => {
    const seenAt = new Date('2026-10-12T09:00:00Z');
    const { rerender } = render(
      <SourceAttribution
        job={makeJob({
          sources: [
            { id: 'greenhouse', url: 'https://jobs.example.test/a', externalId: '1', seenAt },
            { id: 'adzuna', url: 'https://jobs.example.test/b', externalId: '2', seenAt },
          ],
        })}
      />,
    );
    expect(screen.getByRole('img', { name: 'Adzuna' })).toBeDefined();
    rerender(
      <SourceAttribution
        job={makeJob({
          sources: [
            { id: 'reed', url: 'https://jobs.example.test/reed/9', externalId: '9', seenAt },
          ],
        })}
      />,
    );
    expect(screen.getByRole('link', { name: 'via Reed' }).getAttribute('href')).toBe(
      'https://jobs.example.test/reed/9',
    );
    expect(screen.queryByRole('img')).toBeNull();
    rerender(<SourceAttribution job={makeJob()} />);
    expect(screen.queryByRole('link')).toBeNull();
  });
});
