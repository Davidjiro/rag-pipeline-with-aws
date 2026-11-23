/** Sign in with email and password; on first sign-in, choose a new password (accounts are created by invitation). */

import { useState, type FormEvent } from 'react';
import { authErrorMessage, currentUser, PASSWORD_RULE, setNewPassword, startSignIn } from '../lib/auth';

export function SignIn({ notice, onSignedIn }: { notice?: string; onSignedIn: (email: string) => void }) {
  const [step, setStep] = useState<'credentials' | 'newPassword'>('credentials');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newPassword, setNewPasswordValue] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function finish(result: 'signedIn' | 'newPasswordRequired') {
    if (result === 'newPasswordRequired') {
      setStep('newPassword');
      setPassword('');
      return;
    }
    onSignedIn((await currentUser()) ?? email.trim());
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    if (step === 'newPassword' && newPassword !== confirm) {
      setError('The two passwords do not match.');
      return;
    }
    setBusy(true);
    try {
      await finish(step === 'credentials' ? await startSignIn(email, password) : await setNewPassword(newPassword));
    } catch (e) {
      setError(authErrorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="centered">
      <form className="panel signin" onSubmit={submit} aria-label="Sign in">
        <h1>Knowledge Chat</h1>
        {step === 'credentials' ? (
          <>
            <p className="muted">Sign in with the account you were invited with.</p>
            {notice && <p className="notice">{notice}</p>}
            <label>
              Email
              <input
                type="email"
                autoComplete="username"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
            <label>
              Password
              <input
                type="password"
                autoComplete="current-password"
                required
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          </>
        ) : (
          <>
            <p>Choose a new password to finish setting up your account.</p>
            <p className="muted small">{PASSWORD_RULE}</p>
            <label>
              New password
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={newPassword}
                onChange={(e) => setNewPasswordValue(e.target.value)}
              />
            </label>
            <label>
              Repeat new password
              <input
                type="password"
                autoComplete="new-password"
                required
                minLength={12}
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </label>
          </>
        )}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <button type="submit" className="primary" disabled={busy}>
          {busy ? 'Please wait…' : step === 'credentials' ? 'Sign in' : 'Set password and sign in'}
        </button>
      </form>
    </div>
  );
}
