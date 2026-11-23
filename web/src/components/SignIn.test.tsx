import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SignIn } from './SignIn';

const auth = vi.hoisted(() => ({
  startSignIn: vi.fn(),
  setNewPassword: vi.fn(),
  currentUser: vi.fn(async () => 'user@example.com'),
}));
vi.mock('../lib/auth', async (original) => ({ ...(await original<typeof import('../lib/auth')>()), ...auth }));

beforeEach(() => vi.clearAllMocks());

test('an invited user signs in, sets a new password, and is signed in', async () => {
  auth.startSignIn.mockResolvedValue('newPasswordRequired');
  auth.setNewPassword.mockResolvedValue('signedIn');
  const onSignedIn = vi.fn();
  render(<SignIn onSignedIn={onSignedIn} />);

  await userEvent.type(screen.getByLabelText('Email'), 'user@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'Temporary1!');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));

  await userEvent.type(await screen.findByLabelText('New password'), 'A-new-Passw0rd!');
  await userEvent.type(screen.getByLabelText('Repeat new password'), 'A-new-Passw0rd!');
  await userEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));

  expect(auth.startSignIn).toHaveBeenCalledWith('user@example.com', 'Temporary1!');
  expect(auth.setNewPassword).toHaveBeenCalledWith('A-new-Passw0rd!');
  expect(onSignedIn).toHaveBeenCalledWith('user@example.com');
});

test('mismatched new passwords are caught before calling Cognito', async () => {
  auth.startSignIn.mockResolvedValue('newPasswordRequired');
  render(<SignIn onSignedIn={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Email'), 'u@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  await userEvent.type(await screen.findByLabelText('New password'), 'A-new-Passw0rd!');
  await userEvent.type(screen.getByLabelText('Repeat new password'), 'Different-Passw0rd!');
  await userEvent.click(screen.getByRole('button', { name: 'Set password and sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('do not match');
  expect(auth.setNewPassword).not.toHaveBeenCalled();
});

test('a wrong password shows a message that does not reveal whether the account exists', async () => {
  auth.startSignIn.mockRejectedValue(
    Object.assign(new Error('User does not exist.'), { name: 'UserNotFoundException' }),
  );
  render(<SignIn onSignedIn={vi.fn()} />);
  await userEvent.type(screen.getByLabelText('Email'), 'nobody@example.com');
  await userEvent.type(screen.getByLabelText('Password'), 'x');
  await userEvent.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByRole('alert')).toHaveTextContent('Incorrect email or password.');
});
