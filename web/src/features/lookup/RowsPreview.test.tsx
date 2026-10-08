import type { LookupRow } from '@hireframe/shared';
import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RowsPreview } from './RowsPreview';

const row = (n: number): LookupRow => ({
  title: `Analyst ${String(n)}`,
  company: 'Example Co',
  location: 'Leeds',
});

function preview(read: number, linkCount: number) {
  render(
    <RowsPreview
      rows={Array.from({ length: read }, (_, n) => ({ row: row(n), view: null }))}
      linkCount={linkCount}
      picked={new Set()}
      adding={false}
      onPick={vi.fn()}
      onOpen={vi.fn()}
      onAdd={vi.fn()}
    />,
  );
}

describe('RowsPreview counts', () => {
  it('shows the links that were not read as cards', () => {
    preview(24, 25);
    expect(screen.getByText('24 read · 24 new · 1 not read')).toBeDefined();
  });

  it('shows no difference when every link was read', () => {
    preview(3, 3);
    expect(screen.getByText('3 read · 3 new')).toBeDefined();
  });
});
