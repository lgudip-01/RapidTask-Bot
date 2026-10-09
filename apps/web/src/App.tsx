import { HelloResponseSchema, type HelloResponse } from '@planner/shared';
import { useEffect, useState } from 'react';

export function App() {
  const [hello, setHello] = useState<HelloResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/hello')
      .then((r) => r.json())
      .then((json) => setHello(HelloResponseSchema.parse(json)))
      .catch(() => setError('Could not reach the server.'));
  }, []);

  return (
    <main className="mx-auto max-w-xl p-8 font-sans">
      <h1 className="text-2xl font-semibold">Planner</h1>
      <p className="mt-4 text-gray-700">{error ?? hello?.message ?? 'Loading…'}</p>
    </main>
  );
}
