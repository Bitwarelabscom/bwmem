// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (c) 2024 BitwareLabs

import { createTransport, type Transporter } from 'nodemailer';
import type { Logger } from '../../types.js';

export interface EmailService {
  sendVerificationEmail(to: string, token: string, tenantName: string): Promise<void>;
  sendMagicLinkEmail(to: string, token: string, tenantName: string): Promise<void>;
  sendKeyRotatedEmail(to: string, tenantName: string, newPrefix: string, graceHours: number): Promise<void>;
}

export interface EmailConfig {
  transport?: 'sendmail' | 'smtp';
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpTlsRejectUnauthorized?: boolean;
  from: string;
  baseUrl: string;
  logger: Logger;
}

export function createEmailService(config: EmailConfig): EmailService {
  const { from, baseUrl, logger } = config;

  let transport: Transporter;
  if (config.transport === 'smtp') {
    transport = createTransport({
      host: config.smtpHost ?? '127.0.0.1',
      port: config.smtpPort ?? 587,
      secure: config.smtpSecure ?? (config.smtpPort === 465),
      tls: { rejectUnauthorized: config.smtpTlsRejectUnauthorized ?? true },
    });
  } else {
    transport = createTransport({
      sendmail: true,
      newline: 'unix',
      path: '/usr/sbin/sendmail',
    });
  }

  async function send(to: string, subject: string, text: string): Promise<void> {
    try {
      await transport.sendMail({ from, to, subject, text });
      logger.info('Email sent', { to, subject });
    } catch (err) {
      logger.error('Failed to send email', { to, subject, error: (err as Error).message });
    }
  }

  async function sendVerificationEmail(to: string, token: string, tenantName: string): Promise<void> {
    const url = `${baseUrl}/api/v1/auth/verify?token=${encodeURIComponent(token)}`;
    await send(to, 'Verify your bwmem API account', [
      `Hi ${tenantName},`,
      '',
      'Click the link below to verify your email and activate your API key:',
      '',
      url,
      '',
      'This link expires in 24 hours.',
      '',
      "If you didn't create a bwmem account, ignore this email.",
      '',
      '-- bwmem by BitwareLabs',
    ].join('\n'));
  }

  async function sendMagicLinkEmail(to: string, token: string, tenantName: string): Promise<void> {
    const url = `${baseUrl}/api/v1/auth/verify?token=${encodeURIComponent(token)}`;
    await send(to, 'Your bwmem login link', [
      `Hi ${tenantName},`,
      '',
      'Click the link below to log in to your bwmem account:',
      '',
      url,
      '',
      'This link expires in 15 minutes and can only be used once.',
      '',
      "If you didn't request this, ignore this email.",
      '',
      '-- bwmem by BitwareLabs',
    ].join('\n'));
  }

  async function sendKeyRotatedEmail(to: string, tenantName: string, newPrefix: string, graceHours: number): Promise<void> {
    await send(to, 'bwmem API key rotated', [
      `Hi ${tenantName},`,
      '',
      `Your API key has been rotated. New key prefix: ${newPrefix}`,
      '',
      `Your previous key will continue to work for ${graceHours} hours.`,
      '',
      'If you did not initiate this rotation, contact support immediately.',
      '',
      '-- bwmem by BitwareLabs',
    ].join('\n'));
  }

  return { sendVerificationEmail, sendMagicLinkEmail, sendKeyRotatedEmail };
}
