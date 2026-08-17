/** Account creation. The form and its error handling live in `AuthForm`. */

import { PageShell } from '@/components/PageState';
import { AuthForm } from '@/components/AuthForm';

export default function SignupPage() {
  return (
    <PageShell>
      <div className="py-10">
        <AuthForm mode="signup" />
      </div>
    </PageShell>
  );
}
