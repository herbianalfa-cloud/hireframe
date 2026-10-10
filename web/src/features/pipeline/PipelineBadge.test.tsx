import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { PipelineBadge, pipelineLabel, todoText } from './PipelineBadge';

describe('pipelineLabel', () => {
  it('names the count in the link, so the badge itself can stay decorative', () => {
    expect(pipelineLabel('Pipeline', { status: 'ready', count: 3, capped: false })).toBe(
      'Pipeline, 3 to do',
    );
    expect(pipelineLabel('Pipeline', { status: 'ready', count: 50, capped: true })).toBe(
      'Pipeline, 50+ to do',
    );
  });

  it('is just the label while loading and at 0', () => {
    expect(pipelineLabel('Pipeline', { status: 'loading' })).toBe('Pipeline');
    expect(pipelineLabel('Pipeline', { status: 'ready', count: 0, capped: false })).toBe(
      'Pipeline',
    );
  });

  it('says the count is unavailable when the read failed', () => {
    expect(pipelineLabel('Pipeline', { status: 'error' })).toBe(
      'Pipeline, to-do count unavailable',
    );
  });
});

describe('PipelineBadge', () => {
  it('shows nothing at 0', () => {
    const { container } = render(
      <PipelineBadge state={{ status: 'ready', count: 0, capped: false }} />,
    );
    expect(container.textContent).toBe('');
    expect(container.firstChild).toBeNull();
  });

  it('shows the number from 1, and "n+" at the limit', () => {
    const one = render(<PipelineBadge state={{ status: 'ready', count: 1, capped: false }} />);
    expect(one.container.textContent).toBe('1');
    one.unmount();
    const capped = render(<PipelineBadge state={{ status: 'ready', count: 50, capped: true }} />);
    expect(capped.container.textContent).toBe('50+');
  });

  it('shows a skeleton while loading and a dash when it failed', () => {
    const loading = render(<PipelineBadge state={{ status: 'loading' }} />);
    expect(loading.getByTestId('pipeline-badge-skeleton')).toBeDefined();
    expect(loading.container.textContent).toBe('');
    loading.unmount();
    const failed = render(<PipelineBadge state={{ status: 'error' }} />);
    expect(failed.container.textContent).toBe('–');
  });

  it('todoText is empty unless there is something to do', () => {
    expect(todoText({ status: 'loading' })).toBe('');
    expect(todoText({ status: 'error' })).toBe('');
    expect(todoText({ status: 'ready', count: 0, capped: false })).toBe('');
  });
});
