/** Account creation. The form and its error handling live in `AuthForm`. */

import { PageShell } from '@/components/PageState';
import { AuthForm } from '@/components/AuthForm';
import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Open a paper sandbox · Aurelius',
  description: 'Create an account and start on paper.',
};

export default function SignupPage() {
  return (
    <PageShell>
      <div className="py-10">
        <AuthForm mode="signup" />
      </div>
    </PageShell>
  );
}
