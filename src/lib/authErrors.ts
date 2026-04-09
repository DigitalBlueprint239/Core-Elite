import type { AuthError } from '@supabase/supabase-js';

/**
 * Maps Supabase auth errors to safe, user-facing messages.
 *
 * Security invariant: wrong-password and email-not-found produce the SAME
 * message so that an attacker cannot enumerate registered addresses.
 */
export function classifyAuthError(error: AuthError): string {
  const msg = (error.message ?? '').toLowerCase();
  const status = error.status ?? 0;

  if (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed')
  ) {
    return "Can't reach the server. Check your internet connection and try again.";
  }

  if (status === 429 || msg.includes('too many') || msg.includes('rate limit')) {
    return 'Too many sign-in attempts. Wait a few minutes, then try again.';
  }

  if (msg.includes('email not confirmed') || msg.includes('email_not_confirmed')) {
    return "Your account hasn't been verified yet. Check your inbox for a confirmation email.";
  }

  // Intentionally identical for "wrong password" AND "email not found" —
  // prevents email enumeration.
  if (
    status === 400 ||
    status === 401 ||
    msg.includes('invalid login') ||
    msg.includes('invalid credentials') ||
    msg.includes('email or password')
  ) {
    return 'Email or password is incorrect. Double-check and try again.';
  }

  if (status >= 500) {
    return 'Something went wrong on our end. Please try again in a moment.';
  }

  return 'Sign-in failed. Try again, or use "Forgot password?" below to reset.';
}

/**
 * For the password-reset request step.
 * Only network/server faults are surfaced; "not found" is swallowed so we
 * never confirm whether an address is registered.
 * Returns '' when the caller should silently advance to the confirmation screen.
 */
export function classifyResetError(error: AuthError): string {
  const msg = (error.message ?? '').toLowerCase();
  const status = error.status ?? 0;

  if (
    msg.includes('failed to fetch') ||
    msg.includes('networkerror') ||
    msg.includes('network request failed')
  ) {
    return "Can't reach the server. Check your connection and try again.";
  }

  if (status === 429 || msg.includes('too many') || msg.includes('rate limit')) {
    return 'Too many requests. Wait a few minutes before trying again.';
  }

  if (status >= 500) {
    return 'Something went wrong. Please try again.';
  }

  // All other errors (including "email not found") → advance to confirmation.
  return '';
}
