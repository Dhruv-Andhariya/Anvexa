import type { Metadata } from 'next';
import { SignupForm } from './signup-form';

export const metadata: Metadata = { title: 'Create your account · ANVEXA' };

export default function SignupPage() {
  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-4 py-8">
      <p className="mb-6 text-center text-base font-semibold tracking-tight">ANVEXA</p>
      <SignupForm />
    </main>
  );
}
