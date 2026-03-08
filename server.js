'use strict';

const crypto = require('crypto');
const fs = require('fs/promises');
const path = require('path');

const dotenv = require('dotenv');
const express = require('express');
const rateLimit = require('express-rate-limit');
const helmet = require('helmet');
const nodemailer = require('nodemailer');
const { Pool } = require('pg');
const { z } = require('zod');

dotenv.config();

const app = express();
const PORT = Number(process.env.PORT || 3000);
const FRONTEND_DIR = path.join(__dirname, 'frontend');
const DATA_DIR = path.join(__dirname, 'data');
const CONTACT_LOG_FILE = path.join(DATA_DIR, 'contact-messages.ndjson');
const RESUME_FILE = path.join(FRONTEND_DIR, 'assets', 'Mohammed_Suhail_Resume.docx');
const isVercelRuntime = process.env.VERCEL === '1';

const hasRealEnvValue = (value) => {
    const normalized = String(value || '').trim().toLowerCase();
    if (!normalized) {
        return false;
    }

    // Prevent placeholder defaults from being treated as real secrets.
    const placeholderMarkers = [
        'your_',
        'example',
        'changeme',
        'replace_me',
        'password',
        'username'
    ];

    return !placeholderMarkers.some((marker) => normalized.includes(marker));
};

const isTurnstileConfigured = process.env.DISABLE_TURNSTILE !== 'true'
    && hasRealEnvValue(process.env.TURNSTILE_SITE_KEY)
    && hasRealEnvValue(process.env.TURNSTILE_SECRET_KEY);

app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? 1 : 0);
app.disable('x-powered-by');

app.use(helmet({
    contentSecurityPolicy: false,
    crossOriginEmbedderPolicy: false
}));

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

const contactLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 5,
    standardHeaders: true,
    legacyHeaders: false,
    message: {
        ok: false,
        message: 'Too many requests. Please try again later.'
    }
});

const databaseUrl = hasRealEnvValue(process.env.DATABASE_URL) ? process.env.DATABASE_URL : '';
const dbPool = databaseUrl ? new Pool({
    connectionString: databaseUrl,
    ssl: process.env.DATABASE_SSL === 'true' ? { rejectUnauthorized: false } : false
}) : null;

if (dbPool) {
    dbPool.on('error', (error) => {
        console.error('Database pool error:', error);
    });
}

const isSmtpConfigured = [
    'SMTP_HOST',
    'SMTP_PORT',
    'SMTP_USER',
    'SMTP_PASS',
    'CONTACT_TO_EMAIL'
].every((key) => hasRealEnvValue(process.env[key]));

const mailTransporter = isSmtpConfigured ? nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT),
    secure: process.env.SMTP_SECURE === 'true',
    auth: {
        user: process.env.SMTP_USER,
        pass: process.env.SMTP_PASS
    }
}) : null;

const controlCharsPattern = /[\u0000-\u001F\u007F]/g;
const repeatedWhitespacePattern = /\s+/g;

const normalizeText = (value) => String(value || '')
    .replace(controlCharsPattern, '')
    .replace(repeatedWhitespacePattern, ' ')
    .trim();

const normalizeMessage = (value) => String(value || '')
    .replace(controlCharsPattern, '')
    .trim();

const contactSchema = z.object({
    name: z.string().min(2).max(80),
    email: z.string().email().max(254),
    message: z.string().min(5).max(2000),
    company: z.string().max(120).optional().default(''),
    turnstileToken: z.string().max(2048).optional().default('')
});

const getClientIp = (request) => {
    const forwarded = request.headers['x-forwarded-for'];
    if (typeof forwarded === 'string' && forwarded.length > 0) {
        return forwarded.split(',')[0].trim();
    }
    return (request.socket.remoteAddress || '').trim();
};

const verifyTurnstileToken = async (token, clientIp) => {
    const secretKey = process.env.TURNSTILE_SECRET_KEY;
    if (!secretKey) {
        throw new Error('TURNSTILE_SECRET_KEY is missing.');
    }

    const body = new URLSearchParams();
    body.set('secret', secretKey);
    body.set('response', token);
    if (clientIp) {
        body.set('remoteip', clientIp);
    }

    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body
    });

    if (!response.ok) {
        throw new Error(`Turnstile verification failed with status ${response.status}`);
    }

    const result = await response.json();
    return Boolean(result.success);
};

const persistContactMessage = async (record) => {
    if (dbPool) {
        await dbPool.query(
            'INSERT INTO contact_messages (name, email, message, ip_address, user_agent, created_at) VALUES ($1, $2, $3, $4, $5, NOW())',
            [record.name, record.email, record.message, record.ipAddress, record.userAgent]
        );
        return;
    }

    // Vercel's filesystem is ephemeral/read-only for project paths; do not fail contact flow on local file fallback.
    if (isVercelRuntime) {
        console.warn('Skipping local file persistence in Vercel runtime because storage is ephemeral.');
        return;
    }

    try {
        await fs.mkdir(DATA_DIR, { recursive: true });
        const line = `${JSON.stringify({
            ...record,
            createdAt: new Date().toISOString()
        })}\n`;
        await fs.appendFile(CONTACT_LOG_FILE, line, 'utf8');
    } catch (error) {
        // Keep submission success if persistence fallback is unavailable.
        console.error('Local file persistence failed:', error);
    }
};

const sendContactEmail = async (record) => {
    if (!mailTransporter) {
        return;
    }

    const fromEmail = process.env.CONTACT_FROM_EMAIL || process.env.SMTP_USER;
    const toEmail = process.env.CONTACT_TO_EMAIL;

    const messageText = [
        'New contact form submission',
        '',
        `Name: ${record.name}`,
        `Email: ${record.email}`,
        `IP: ${record.ipAddress || 'unknown'}`,
        '',
        'Message:',
        record.message
    ].join('\n');

    await mailTransporter.sendMail({
        from: fromEmail,
        to: toEmail,
        replyTo: record.email,
        subject: `Portfolio contact from ${record.name}`,
        text: messageText
    });
};

app.get(['/api/health', '/health'], (_request, response) => {
    response.json({ ok: true });
});

app.get(['/api/config', '/config'], (_request, response) => {
    response.json({
        turnstileEnabled: isTurnstileConfigured,
        turnstileSiteKey: isTurnstileConfigured ? process.env.TURNSTILE_SITE_KEY : ''
    });
});

app.post(['/api/contact', '/contact'], contactLimiter, async (request, response) => {
    const requestId = crypto.randomUUID();

    try {
        // Treat all external inputs as untrusted and normalize before validation.
        const payload = {
            name: normalizeText(request.body.name),
            email: normalizeText(request.body.email).toLowerCase(),
            message: normalizeMessage(request.body.message),
            company: normalizeText(request.body.company),
            turnstileToken: normalizeText(request.body.turnstileToken || request.body['cf-turnstile-response'])
        };

        const parsed = contactSchema.safeParse(payload);
        if (!parsed.success) {
            return response.status(400).json({
                ok: false,
                message: 'Please check the form fields and try again.'
            });
        }

        const data = parsed.data;
        if (data.company.length > 0) {
            // Honeypot was filled, silently accept to avoid helping bots.
            return response.status(200).json({
                ok: true,
                message: 'Message received.'
            });
        }

        const clientIp = getClientIp(request);
        const shouldVerifyCaptcha = isTurnstileConfigured;
        if (shouldVerifyCaptcha) {
            if (!data.turnstileToken || data.turnstileToken.length < 20) {
                return response.status(400).json({
                    ok: false,
                    message: 'Security verification is required. Please try again.'
                });
            }

            const verified = await verifyTurnstileToken(data.turnstileToken, clientIp);
            if (!verified) {
                return response.status(400).json({
                    ok: false,
                    message: 'Security verification failed. Please try again.'
                });
            }
        }

        const record = {
            name: data.name,
            email: data.email,
            message: data.message,
            ipAddress: clientIp,
            userAgent: normalizeText(request.headers['user-agent'] || 'unknown')
        };

        await persistContactMessage(record);

        try {
            await sendContactEmail(record);
        } catch (emailError) {
            console.error(`[contact:${requestId}] Email delivery failed:`, emailError);
        }

        return response.status(200).json({
            ok: true,
            message: 'Message sent successfully.'
        });
    } catch (error) {
        // Log detailed server-side error and return generic client-safe message.
        console.error(`[contact:${requestId}] Contact handler error:`, error);
        return response.status(500).json({
            ok: false,
            message: 'Unable to send message right now. Please try again later.'
        });
    }
});

app.get(['/resume', '/api/resume'], (request, response) => {
    response.download(RESUME_FILE, 'Mohammed_Suhail_Resume.docx', (error) => {
        if (error && !response.headersSent) {
            console.error('Resume download failed:', error);
            response.status(404).send('Resume file not found.');
        }
    });
});

app.use(express.static(FRONTEND_DIR, { extensions: ['html'] }));

app.get('*', (_request, response) => {
    response.sendFile(path.join(FRONTEND_DIR, 'index.html'));
});

if (require.main === module) {
    app.listen(PORT, () => {
        console.log(`Server running on http://localhost:${PORT}`);

        if (!isTurnstileConfigured) {
            console.warn('Turnstile is disabled or not fully configured. Set DISABLE_TURNSTILE=false and provide TURNSTILE_SITE_KEY + TURNSTILE_SECRET_KEY to enable it.');
        }
        if (!mailTransporter) {
            console.warn('SMTP is not configured. Messages will be stored locally and/or in the database.');
        }
        if (!dbPool) {
            console.warn(`DATABASE_URL is not configured. Messages will be stored in ${CONTACT_LOG_FILE}.`);
        }
    });
}

module.exports = app;
