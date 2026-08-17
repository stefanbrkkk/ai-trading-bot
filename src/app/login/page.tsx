/** Sign-in. The form and its error handling live in `AuthForm`. */

import { PageShell } from '@/components/PageState';
import { AuthForm } from '@/components/AuthForm';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Sign in · Aurelius',
  description: 'Return to the terminal.',
};

export default function LoginPage() {
  return (
    <PageShell>
      <div className="py-10">
        <AuthForm mode="signin" />
      </div>
    </PageShell>
  );
}
