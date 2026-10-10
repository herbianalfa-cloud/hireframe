import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Timestamp } from 'firebase/firestore';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { saveCvHeader, watchCvHeader, type CvHeaderView } from '@/services/profile';

import { CvHeaderCard } from './CvHeaderCard';

vi.mock('@/services/profile', () => ({
  watchCvHeader: vi.fn(),
  saveCvHeader: vi.fn(),
}));

function given(data: CvHeaderView | null) {
  vi.mocked(watchCvHeader).mockImplementation((callback) => {
    callback({ status: 'ready', data, invalid: data && !data.header ? 1 : 0 });
    return () => undefined;
  });
}

const CREATED = Timestamp.fromDate(new Date('2026-10-01T09:00:00Z'));

const STORED: CvHeaderView = {
  header: {
    name: 'Alex Example',
    email: 'alex@example.com',
    location: 'London, UK',
    links: ['https://example.com/alex'],
    createdAt: CREATED.toDate(),
    updatedAt: CREATED.toDate(),
    schemaVersion: 1,
  },
  raw: {
    name: 'Alex Example',
    email: 'alex@example.com',
    location: 'London, UK',
    links: ['https://example.com/alex'],
    createdAt: CREATED,
    updatedAt: CREATED,
    schemaVersion: 1,
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(saveCvHeader).mockResolvedValue();
});

describe('CvHeaderCard', () => {
  it('explains that no CV can be written until a header is saved', () => {
    given(null);
    render(<CvHeaderCard />);
    expect(screen.getByText(/can’t be written until you save a name and an email/)).toBeDefined();
  });

  it('shows a skeleton while loading and an error when the read fails', () => {
    vi.mocked(watchCvHeader).mockImplementationOnce((callback) => {
      callback({ status: 'loading' });
      return () => undefined;
    });
    const { unmount } = render(<CvHeaderCard />);
    expect(screen.getByRole('status', { name: 'Loading CV header' })).toBeDefined();
    unmount();
    vi.mocked(watchCvHeader).mockImplementationOnce((callback) => {
      callback({ status: 'error', message: "Couldn't load your CV header. Reload to try again." });
      return () => undefined;
    });
    render(<CvHeaderCard />);
    expect(screen.getByRole('alert').textContent).toMatch(/Couldn't load your CV header/);
  });

  it('saves a new header, leaving blank optional fields out of the values it sends', async () => {
    const user = userEvent.setup();
    given(null);
    render(<CvHeaderCard />);
    await user.type(screen.getByLabelText('Full name'), 'Alex Example');
    await user.type(screen.getByLabelText('Email'), 'alex@example.com');
    await user.click(screen.getByRole('button', { name: 'Save CV header' }));
    expect(saveCvHeader).toHaveBeenCalledWith(
      {
        name: 'Alex Example',
        email: 'alex@example.com',
        phone: '',
        location: '',
        links: ['', '', ''],
      },
      null,
    );
    expect(await screen.findByText('Saved. New CVs use it.')).toBeDefined();
  });

  it('validates with the shared schema before writing, and shows each error on its field', async () => {
    const user = userEvent.setup();
    given(null);
    render(<CvHeaderCard />);
    await user.type(screen.getByLabelText('Email'), 'not-an-email');
    await user.type(screen.getByLabelText('Link 1 (optional)'), 'http://plain.example');
    await user.click(screen.getByRole('button', { name: 'Save CV header' }));
    expect(saveCvHeader).not.toHaveBeenCalled();
    expect(screen.getByText('Enter your name (up to 80 characters).')).toBeDefined();
    expect(screen.getByText(/Enter a valid email address/)).toBeDefined();
    expect(screen.getByText(/Use a full https:\/\/ link/)).toBeDefined();
    expect(screen.getByLabelText('Email').getAttribute('aria-invalid')).toBe('true');
  });

  it('starts from the stored header and passes it back on save, so createdAt is kept', async () => {
    const user = userEvent.setup();
    given(STORED);
    render(<CvHeaderCard />);
    expect(screen.getByLabelText<HTMLInputElement>('Full name').value).toBe('Alex Example');
    expect(screen.getByLabelText<HTMLInputElement>('Link 1 (optional)').value).toBe(
      'https://example.com/alex',
    );
    await user.type(screen.getByLabelText('Phone (optional)'), '020 7946 0000');
    await user.click(screen.getByRole('button', { name: 'Save CV header' }));
    expect(saveCvHeader).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'Alex Example', phone: '020 7946 0000' }),
      STORED,
    );
  });

  it('offers an unreadable stored header for repair, prefilled with what it holds', () => {
    given({ header: null, raw: { name: 'Alex Example', email: 'broken', createdAt: CREATED } });
    render(<CvHeaderCard />);
    expect(screen.getByText(/can’t be used as it is/)).toBeDefined();
    expect(screen.getByLabelText<HTMLInputElement>('Email').value).toBe('broken');
  });

  it('shows an error when saving fails', async () => {
    const user = userEvent.setup();
    given(STORED);
    vi.mocked(saveCvHeader).mockRejectedValue(new Error('offline'));
    render(<CvHeaderCard />);
    await user.type(screen.getByLabelText('Phone (optional)'), '1');
    await user.click(screen.getByRole('button', { name: 'Save CV header' }));
    expect(
      await screen.findByText("Couldn't save. Check your connection and try again."),
    ).toBeDefined();
  });
});
