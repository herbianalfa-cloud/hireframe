import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ErrorBoundary } from './ErrorBoundary';

function Broken(): never {
  throw new Error('chunk 3f2a is gone');
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('ErrorBoundary', () => {
  it('renders its children when nothing fails', () => {
    render(
      <ErrorBoundary what="The panel">
        <p>fine</p>
      </ErrorBoundary>,
    );
    expect(screen.getByText('fine')).toBeDefined();
  });

  it('shows a reload message instead of blanking the page, and logs the name only', () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    render(
      <>
        <p>rest of the page</p>
        <ErrorBoundary what="The panel">
          <Broken />
        </ErrorBoundary>
      </>,
    );
    expect(screen.getByText('rest of the page')).toBeDefined();
    expect(screen.getByRole('alert').textContent).toContain("The panel didn't load. Reload");
    expect(screen.getByRole('button', { name: 'Reload' })).toBeDefined();
    const ours = logged.mock.calls
      .map((call) => String(call[0]))
      .find((line) => line.includes('ui.render_failed'));
    expect(ours).toContain('"name":"Error"');
    expect(ours).not.toContain('3f2a');
  });
});
