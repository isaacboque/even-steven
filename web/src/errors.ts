/** Turns raw API errors into messages a person can act on. */
const plural = (n: number) => `${n} cent${n === 1 ? "" : "s"}`;

export function friendlyError(message: string): string {
  if (/401|unauthori[sz]ed|invalid_client|authenticat|access token/i.test(message)) {
    return "PayPal rejected the sandbox credentials. Check PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in your .env, then restart the server.";
  }
  const off = /off by (-?\d+) cents?/i.exec(message);
  if (off) return mismatchMessage(Number(off[1]));
  return message;
}

/** `diffCents` = receipt total minus (items + tax + tip). */
export function mismatchMessage(diffCents: number): string {
  const n = Math.abs(diffCents);
  return `The receipt total does not match the lines: ${diffCents > 0 ? "the total is" : "the lines add up to"} ${plural(n)} more. Fix a line or the total before continuing.`;
}
