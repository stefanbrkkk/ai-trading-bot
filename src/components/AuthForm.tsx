/**
 * Sign-in and sign-up, sharing one form.
 *
 * The two flows differ by one field and one endpoint, so they share an
 * implementation — but the *error* handling is the reason this is a component
 * rather than two pages of duplicated JSX. Authentication failures have to be
 * reported using the server's own message and nothing more: an error that
 * distinguishes "no such account" from "wrong password" tells an attacker which
 * emails are registered, and inventing a friendlier message client-side would
 * reintroduce exactly that distinction. So the server sends one string and this
 * renders it verbatim.
 */

'use client';

import { useState } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { Button, Field, INPUT_CLASS, Notice, Panel, PanelHeader } from '@/components/ui/primitives';
import { ApiRequestError, request, type MeResponse } from '@/lib/ui/api';

export function AuthForm({ mode }: { mode: 'signin' | 'signup' }) {
  const router = useRouter();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const signup = mode === 'signup';

  async function submit(event: React.FormEvent<HTMLFormElement>): Promise<void> {
    event.preventDefault();
    if (pending) return;
    setPending(true);
    setError(null);

    try {
      const response = await request<MeResponse>(signup ? '/auth/signup' : '/auth/signin', {
        method: 'POST',
        body: signup ? { email, password, displayName: displayName.trim() } : { email, password },
      });

      /**
       * Where to go next is decided by entitlement, not by the mode.
       *
       * A new account has not accepted the terms, so it cannot route anything and
       * the only useful destination is the clickwrap. But an *existing* account
       * signing in may also be un-accepted — the terms version may have changed
       * since they last agreed — so the same check applies to both paths rather
       * than assuming sign-in implies consent.
       */
      const accepted = response.user?.tosAcceptedAt !== null && response.user?.tosAcceptedAt !== undefined;
      router.push(accepted ? '/terminal' : '/onboarding');
      // Refresh so the shell's session-dependent chrome re-reads /auth/me.
      router.refresh();
    } catch (cause) {
      setError(
        cause instanceof ApiRequestError
          ? cause.message
          : 'The request could not be completed. Check your connection and try again.',
      );
      setPending(false);
    }
  }

  return (
    <Panel className="mx-auto w-full max-w-md">
      <PanelHeader
        // These two pages carry no `PageHeader`, so this is the page's `h1`.
        as="h1"
        eyebrow={signup ? 'Create an account' : 'Sign in'}
        title={signup ? 'Open a paper sandbox' : 'Return to the terminal'}
        detail={
          signup
            ? 'A new account begins with a paper sandbox. Live routing requires an active subscription and an explicit unlock — a trial does not confer it.'
            : undefined
        }
      />

      <form className="mt-5 space-y-4" onSubmit={submit} noValidate>
        {signup ? (
          <Field label="Display name" hint="Shown in the terminal chrome only.">
            <input
              className={INPUT_CLASS}
              type="text"
              name="displayName"
              autoComplete="name"
              maxLength={60}
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
            />
          </Field>
        ) : null}

        <Field label="Email" required>
          <input
            className={INPUT_CLASS}
            type="email"
            name="email"
            autoComplete="email"
            required
            maxLength={200}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
        </Field>

        <Field
          label="Password"
          required
          hint={signup ? 'At least 12 characters. Stored only as a salted scrypt hash.' : undefined}
        >
          <input
            className={INPUT_CLASS}
            type="password"
            name="password"
            autoComplete={signup ? 'new-password' : 'current-password'}
            required
            minLength={signup ? 12 : 1}
            maxLength={200}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </Field>

        {/* The server's message, unmodified. */}
        {error !== null ? <Notice tone="error">{error}</Notice> : null}

        <Button type="submit" variant="primary" size="lg" className="w-full" busy={pending}>
          {pending ? 'Working…' : signup ? 'Create account' : 'Sign in'}
        </Button>
      </form>

      <p className="mt-5 text-[0.75rem] text-parchment-faint">
        {signup ? 'Already registered? ' : 'No account yet? '}
        <Link href={signup ? '/login' : '/signup'} className="text-gold underline decoration-gold/40 hover:decoration-gold">
          {signup ? 'Sign in' : 'Create one'}
        </Link>
      </p>
    </Panel>
  );
}
