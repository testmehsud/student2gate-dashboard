'use client';

import { FormEvent, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  signInWithEmailAndPassword,
  signOut,
} from 'firebase/auth';
import {
  firebaseAuth,
  setEphemeralAuthPersistence,
} from '@/lib/firebase-client';

export default function LoginPage() {
  const router = useRouter();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function handleSubmit(
    event: FormEvent<HTMLFormElement>,
  ) {
    event.preventDefault();

    setError('');
    setBusy(true);

    try {
      await setEphemeralAuthPersistence();

      /*
       * Start CSRF retrieval and Firebase sign-in at the same time.
       * They are independent operations, so this avoids unnecessary
       * sequential waiting.
       */
      const [csrfResponse, credential] = await Promise.all([
        fetch('/api/auth/csrf', {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
        }),
        signInWithEmailAndPassword(
          firebaseAuth,
          email.trim(),
          password,
        ),
      ]);

      const csrfResult = await csrfResponse
        .json()
        .catch(() => null);

      if (
        !csrfResponse.ok ||
        typeof csrfResult?.token !== 'string'
      ) {
        throw new Error(
          'Unable to start secure login.',
        );
      }

      /*
       * The sign-in just happened, so there is no need to force
       * another Firebase token refresh here.
       */
      const idToken = await credential.user.getIdToken();

      const sessionResponse = await fetch(
        '/api/auth/session',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
          },
          credentials: 'same-origin',
          body: JSON.stringify({
            idToken,
            csrfToken: csrfResult.token,
          }),
        },
      );

      const result = await sessionResponse
        .json()
        .catch(() => null);

      if (!sessionResponse.ok) {
        throw new Error(
          typeof result?.error === 'string'
            ? result.error
            : 'Platform Owner access denied.',
        );
      }

      /*
       * The browser no longer needs Firebase's client-side
       * authenticated state because the server session cookie
       * is now authoritative.
       */
      await signOut(firebaseAuth);

      router.replace('/dashboard');
      router.refresh();
    } catch (err) {
      try {
        await signOut(firebaseAuth);
      } catch {
        // Ignore cleanup failure.
      }

      const message =
        err instanceof Error
          ? err.message
          : 'Login failed.';

      if (
        message.includes('auth/invalid-credential')
      ) {
        setError('Invalid email or password.');
      } else if (
        message.includes('auth/too-many-requests')
      ) {
        setError(
          'Too many login attempts. Try again later.',
        );
      } else {
        setError(message);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="min-h-screen bg-slate-950 flex items-center justify-center px-6">
      <div className="w-full max-w-md rounded-2xl bg-white p-8 shadow-xl">
        <div className="mb-8">
          <p className="text-sm font-semibold text-slate-500">
            Student2Gate
          </p>

          <h1 className="mt-2 text-3xl font-bold text-slate-900">
            Platform Owner
          </h1>

          <p className="mt-2 text-sm text-slate-600">
            Sign in to the management dashboard.
          </p>
        </div>

        <form
          onSubmit={handleSubmit}
          className="space-y-5"
        >
          <div>
            <label
              htmlFor="email"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Email
            </label>

            <input
              id="email"
              type="email"
              autoComplete="username"
              value={email}
              onChange={(event) =>
                setEmail(event.target.value)
              }
              required
              className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
            />
          </div>

          <div>
            <label
              htmlFor="password"
              className="mb-2 block text-sm font-medium text-slate-700"
            >
              Password
            </label>

            <input
              id="password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) =>
                setPassword(event.target.value)
              }
              required
              className="w-full rounded-xl border border-slate-300 px-4 py-3 outline-none focus:border-slate-500"
            />
          </div>

          {error && (
            <div className="rounded-xl bg-red-50 px-4 py-3 text-sm text-red-700">
              {error}
            </div>
          )}

          <button
            type="submit"
            disabled={busy}
            className="w-full rounded-xl bg-slate-900 px-4 py-3 font-semibold text-white disabled:cursor-not-allowed disabled:opacity-60"
          >
            {busy ? 'Signing in...' : 'Sign in'}
          </button>
        </form>
      </div>
    </main>
  );
}