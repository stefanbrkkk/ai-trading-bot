/** Sign-in. The form and its error handling live in `AuthForm`. */

import { PageShell } from '@/components/PageState';
import { AuthForm } from '@/components/AuthForm';

export default function LoginPage() {
  return (
    <PageShell>
      <div className="py-10">
        <AuthForm mode="signin" />
      </div>
    </PageShell>
  );
}
