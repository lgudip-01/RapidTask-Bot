import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

afterEach(() => vi.unstubAllGlobals());

describe('App', () => {
  it('shows the hello message from the API', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ message: 'Hello fixture', time: '2026-10-09T12:00:00.000Z' }),
          ),
        ),
    );
    render(<App />);
    expect(await screen.findByText('Hello fixture')).toBeTruthy();
  });
});
