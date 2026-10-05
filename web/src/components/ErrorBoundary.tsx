import { Component, type ReactNode } from 'react';

import { Button } from '@/components/ui/button';
import { logError } from '@/services/log';

interface Props {
  /** What failed, in a few words: "The S2 skip reasons panel". */
  what: string;
  children: ReactNode;
}

/**
 * Keeps a failed part of a screen (typically a lazy chunk that no longer exists after a deploy)
 * from blanking the rest of it. Logs the error name only, never its message.
 */
export class ErrorBoundary extends Component<Props, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override componentDidCatch(error: Error): void {
    logError('ui.render_failed', { what: this.props.what, name: error.name });
  }

  override render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <div role="alert" className="mt-8 text-sm">
        <p>{this.props.what} didn't load. Reload the page to try again.</p>
        <Button
          type="button"
          variant="secondary"
          className="mt-3"
          onClick={() => {
            window.location.reload();
          }}
        >
          Reload
        </Button>
      </div>
    );
  }
}
