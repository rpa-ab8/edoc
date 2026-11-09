import type { Env } from "../config/env.js";

/**
 * Sends via Brevo's transactional email API when BREVO_API_KEY is configured;
 * otherwise logs to the console. Callers depend only on this interface, not the
 * transport, so swapping providers again later is a one-file change.
 */
export interface Mail {
  to: string;
  subject: string;
  text: string;
}

const BREVO_SEND_ATTEMPTS = 3;
const BREVO_RETRY_DELAYS_MS = [300, 900];

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// This ISP's DNS resolver has shown intermittent failures on outbound lookups
// (observed against both docker.io and api.brevo.com) — retry a network-level
// failure a couple of times before giving up. An actual error response from Brevo
// (bad key, unverified sender, etc.) is not retried — retrying won't fix those.
async function sendViaBrevo(env: Env, mail: Mail): Promise<void> {
  for (let attempt = 0; attempt < BREVO_SEND_ATTEMPTS; attempt++) {
    let res: Response;
    try {
      res = await fetch("https://api.brevo.com/v3/smtp/email", {
        method: "POST",
        headers: {
          "api-key": env.BREVO_API_KEY!,
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          sender: { name: env.EMAIL_FROM_NAME, email: env.EMAIL_FROM },
          to: [{ email: mail.to }],
          subject: mail.subject,
          textContent: mail.text,
        }),
      });
    } catch (err) {
      if (attempt === BREVO_SEND_ATTEMPTS - 1) throw err;
      await delay(BREVO_RETRY_DELAYS_MS[attempt]!);
      continue;
    }
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Brevo send failed (${res.status}): ${body}`);
    }
    return;
  }
}

function logToConsole(mail: Mail): void {
  console.log(`\n--- [dev mailer] to: ${mail.to} | subject: ${mail.subject} ---`);
  console.log(mail.text);
  console.log("--- [end dev mailer] ---\n");
}

export async function sendMail(env: Env, mail: Mail): Promise<void> {
  if (env.MAIL_DISABLED) {
    // Test runs: swallow the send entirely so a real Brevo key in .env doesn't fire live mail
    // (repeated bounces to test addresses hurt sender reputation).
    console.log(`[mailer] suppressed (MAIL_DISABLED): ${mail.subject} → ${mail.to}`);
    return;
  }
  if (env.BREVO_API_KEY) {
    await sendViaBrevo(env, mail);
  } else {
    logToConsole(mail);
  }
}

export function sendVerificationEmail(env: Env, to: string, verifyUrl: string): Promise<void> {
  return sendMail(env, {
    to,
    subject: "Verify your Edoc account",
    text: `Welcome to Edoc. Verify your email by visiting:\n${verifyUrl}\n\nThis link expires soon.`,
  });
}

export function sendPasswordResetEmail(env: Env, to: string, resetUrl: string): Promise<void> {
  return sendMail(env, {
    to,
    subject: "Reset your Edoc password",
    text: `Reset your password by visiting:\n${resetUrl}\n\nIf you didn't request this, ignore this email.`,
  });
}
