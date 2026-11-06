/**
 * Password hashing and policy for QuikReach accounts (standalone/credentials
 * mode only). Mailbox passwords are NEVER requested or stored — mailboxes are
 * connected through provider OAuth.
 */
import bcrypt from "bcryptjs";

export const PASSWORD_MIN_LENGTH = 12;

export function validatePasswordPolicy(password: string): string | null {
  if (password.length < PASSWORD_MIN_LENGTH) return `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`;
  if (password.length > 200) return "Password is too long.";
  if (!/[A-Za-z]/.test(password) || !/[0-9]/.test(password)) return "Password must contain letters and numbers.";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  return bcrypt.hash(password, 12);
}

export async function verifyPassword(password: string, hash: string): Promise<boolean> {
  return bcrypt.compare(password, hash);
}

/** Compared against when the user does not exist, so timing does not reveal account existence. */
export const DUMMY_HASH = "$2b$12$C6UzMDM.H6dfI/f/IKcEeO5c3Q0WZzZx6fC0p7m0wqzv8n7m4d2e6";
