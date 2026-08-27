require('dotenv').config();

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const { URL } = require('url');
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = Number(process.env.PORT) || 3847;
const BASE_URL = (process.env.BASE_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const TINKOFF_TERMINAL_KEY = process.env.TINKOFF_TERMINAL_KEY || '';
const TINKOFF_SECRET_PASSWORD = process.env.TINKOFF_SECRET_PASSWORD || '';
const OPENAI_API_KEY = process.env.OPENAI_API_KEY || '';
const OPENAI_BASE_URL = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(
  /\/$/,
  ''
);
const OPENAI_MODEL = process.env.OPENAI_MODEL || 'gpt-4o-mini';
const TINKOFF_API_URL = 'https://securepay.tinkoff.ru/v2/Init';
const AMOUNT_KOPECKS = 2900;
const RECEIPT_ENABLED = process.env.RECEIPT_ENABLED !== 'false';
const TINKOFF_TAXATION = process.env.TINKOFF_TAXATION || 'usn_income';
const RECEIPT_TAX = process.env.RECEIPT_TAX || 'none';
const RECEIPT_ITEM_NAME = process.env.RECEIPT_ITEM_NAME || 'Предсказание Раскуси';
const INSECURE_TLS =
  process.env.INSECURE_TLS === 'true' || process.env.NODE_TLS_REJECT_UNAUTHORIZED === '0';

if (INSECURE_TLS) {
  console.warn('WARNING: INSECURE_TLS enabled — outbound TLS verification is disabled');
}

const isPlaceholder = (value) =>
  !value ||
  value.includes('your_') ||
  value.includes('_here') ||
  value === 'changeme';

const AI_ENABLED = !isPlaceholder(OPENAI_API_KEY);
const DEMO_MODE =
  process.env.DEMO_MODE === 'true' ||
  isPlaceholder(TINKOFF_TERMINAL_KEY) ||
  isPlaceholder(TINKOFF_SECRET_PASSWORD);

/**
 * Outbound JSON HTTP(S) request. Uses Node https/http instead of fetch so we can
 * disable TLS verification on broken VPS CA chains (INSECURE_TLS=true).
 */
function requestJson(urlString, { method = 'GET', headers = {}, body, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    let parsed;
    try {
      parsed = new URL(urlString);
    } catch (err) {
      reject(err);
      return;
    }

    const isHttps = parsed.protocol === 'https:';
    const lib = isHttps ? https : http;
    const payload = body == null ? null : typeof body === 'string' ? body : JSON.stringify(body);
    const reqHeaders = { ...headers };
    if (payload != null && !reqHeaders['Content-Type'] && !reqHeaders['content-type']) {
      reqHeaders['Content-Type'] = 'application/json';
    }
    if (payload != null) {
      reqHeaders['Content-Length'] = Buffer.byteLength(payload);
    }

    const req = lib.request(
      {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: `${parsed.pathname}${parsed.search}`,
        method,
        headers: reqHeaders,
        rejectUnauthorized: isHttps ? !INSECURE_TLS : undefined,
      },
      (res) => {
        const chunks = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            json = null;
          }
          resolve({
            ok: res.statusCode >= 200 && res.statusCode < 300,
            status: res.statusCode || 0,
            text,
            json,
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Request timeout after ${timeoutMs}ms`));
    });
    req.on('error', reject);
    if (payload != null) req.write(payload);
    req.end();
  });
}

/** @type {Map<string, { orderId: string, name: string, gender: string, question: string, status: string, paymentId?: string, createdAt: number }>} */
const orders = new Map();

const SYSTEM_PROMPT = `Ты пишешь записки из китайского печенья: короткие предсказания-ориентиры.

СТИЛЬ
- Звучит как предсказание: уверенно, образно, чуть загадочно — но без мистики «всё сбудется» и без магии.
- По сути это психологический намёк, завёрнутый в форму записки.
- Только текст. Без эмодзи. Без приветствий, без заголовков, без пояснений «почему».
- Жёстко без воды: никаких вводных, повторов, морализаторства, списков и общих фраз вроде «прислушайся к себе», «всё будет хорошо», «думай позитивно».

ФОРМАТ — ровно 3 блока, разделённых одной пустой строкой. Без меток вроде [БЛОК]. Сразу текст:

1) Предсказание — 1 короткое предложение (до 18 слов). Образ или намёк. Если даны имя/пол/вопрос — учти тонко, не цитируй вопрос целиком.
2) Смысл — 1 короткое предложение (до 16 слов). В чём суть для человека.
3) Шаг — одна конкретная микродействие на сегодня (до 12 слов). Начинай с глагола.

Объём всего ответа: максимум ~45 слов. Лучше короче.

ЗАПРЕТЫ
- Не пиши про смерть, болезни, насилие, катастрофы, финансовый крах.
- На деструктивный/опасный/трешовый вопрос ответь ТОЛЬКО этой фразой:
«К сожалению, печенье не может ответить на этот вопрос. Попробуйте сформулировать запрос иначе, сфокусировавшись на своем внутреннем состоянии или целях.»`;

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));

function renderPublic(fileName) {
  const filePath = path.join(__dirname, 'public', fileName);
  return fs.readFileSync(filePath, 'utf8').split('{{BASE_URL}}').join(BASE_URL);
}

function sendPublicHtml(res, fileName, status = 200) {
  res.status(status).type('html').send(renderPublic(fileName));
}

app.get('/robots.txt', (_req, res) => {
  res.type('text/plain').send(renderPublic('robots.txt'));
});

app.get('/sitemap.xml', (_req, res) => {
  res.type('application/xml').send(renderPublic('sitemap.xml'));
});

app.get(['/', '/index.html'], (_req, res) => sendPublicHtml(res, 'index.html'));
app.get('/offer.html', (_req, res) => sendPublicHtml(res, 'offer.html'));
app.get('/privacy.html', (_req, res) => sendPublicHtml(res, 'privacy.html'));

app.use(express.static(path.join(__dirname, 'public'), { index: false }));

/**
 * T-Bank (Tinkoff) Token: root params except Token/Receipt/DATA,
 * add Password, sort keys, concat values, SHA-256.
 */
function generateTinkoffToken(params, password) {
  const data = { ...params, Password: password };
  delete data.Token;
  delete data.Receipt;
  delete data.DATA;

  const pairs = Object.keys(data)
    .filter((key) => data[key] !== undefined && data[key] !== null && typeof data[key] !== 'object')
    .sort()
    .map((key) => String(data[key]));

  return crypto.createHash('sha256').update(pairs.join('')).digest('hex');
}

function verifyTinkoffToken(payload) {
  if (DEMO_MODE) return true;
  const received = payload.Token;
  if (!received) return false;
  const expected = generateTinkoffToken(payload, TINKOFF_SECRET_PASSWORD);
  return received.toLowerCase() === expected.toLowerCase();
}

function buildUserPrompt({ name, gender, question }) {
  const parts = ['Сделай короткую записку-предсказание (3 блока, без воды).'];
  if (name) parts.push(`Имя: ${name}`);
  if (gender === 'm' || gender === 'f') {
    parts.push(`Пол: ${gender === 'm' ? 'мужской' : 'женский'}`);
  }
  if (question && question.trim()) {
    parts.push(`Вопрос: ${question.trim()}`);
  } else {
    parts.push('Вопрос не задан — универсальное предсказание.');
  }
  return parts.join('\n');
}

const FALLBACK_FORTUNES = [
  {
    block1: 'То, что зреет в тишине, скоро потребует твоего выбора.',
    block2: 'Ясность приходит не от ожидания, а от одного честного шага.',
    block3: 'Назови сегодня одно решение вслух.',
  },
  {
    block1: 'Ответ уже рядом — его закрывает чужое мнение.',
    block2: 'Чем меньше согласований, тем слышнее собственный голос.',
    block3: 'Сделай маленький шаг без чужого одобрения.',
  },
  {
    block1: 'Мягкость сохранит суть там, где сила лишь сломает форму.',
    block2: 'Усталость часто маскируется под безразличие.',
    block3: 'Закрой одно короткое незавершённое дело.',
  },
  {
    block1: 'Знак уже был — ты слишком долго его перепроверял.',
    block2: 'Сомнение полезно до выбора, после него оно только тормозит.',
    block3: 'Сделай первый шаг к одному намерению.',
  },
  {
    block1: 'Путь откроется там, где ты перестанешь держаться за старое удобство.',
    block2: 'Привычка «подождать ещё» сегодня дороже риска.',
    block3: 'Убери одно лишнее обязательство из дня.',
  },
];

function personalizeFallback({ name, question }) {
  const base = FALLBACK_FORTUNES[Math.floor(Math.random() * FALLBACK_FORTUNES.length)];
  let block1 = base.block1;

  if (name) {
    block1 = `${name}, ${block1.charAt(0).toLowerCase()}${block1.slice(1)}`;
  }
  // Keep short even with context — do not append long question quotes

  return [block1, base.block2, base.block3].join('\n\n');
}

function cleanFortuneText(text) {
  return String(text || '')
    .replace(/\[БЛОК\s*\d+[^\]]*\]/gi, '')
    .replace(/^\s*Блок\s*\d+\s*[:.\-–—]?\s*/gim, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

const REFUSAL_SNIPPET = 'печенье не может ответить';

function isRefusalFortune(text) {
  return typeof text === 'string' && text.toLowerCase().includes(REFUSAL_SNIPPET);
}

function normalizeFormInput(body = {}) {
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 80) : '';
  const gender = body.gender === 'm' || body.gender === 'f' ? body.gender : '';
  const question = typeof body.question === 'string' ? body.question.trim().slice(0, 500) : '';
  const emailRaw = typeof body.email === 'string' ? body.email.trim().slice(0, 64) : '';
  const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailRaw) ? emailRaw : '';
  return { name, gender, question, email };
}

function buildReceipt(email) {
  return {
    Email: email,
    Taxation: TINKOFF_TAXATION,
    Items: [
      {
        Name: RECEIPT_ITEM_NAME.slice(0, 128),
        Price: AMOUNT_KOPECKS,
        Quantity: 1,
        Amount: AMOUNT_KOPECKS,
        Tax: RECEIPT_TAX,
        PaymentMethod: 'full_payment',
        PaymentObject: 'service',
        MeasurementUnit: 'шт',
      },
    ],
  };
}

async function generateFortune(userData) {
  if (!AI_ENABLED) {
    console.warn('OPENAI_API_KEY is missing — using local fallback fortune');
    return { text: personalizeFallback(userData), source: 'fallback' };
  }

  try {
    const response = await requestJson(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: {
        model: OPENAI_MODEL,
        temperature: 0.85,
        max_tokens: 180,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(userData) },
        ],
      },
      timeoutMs: 30000,
    });

    if (!response.ok) {
      console.error('OpenAI error:', response.status, String(response.text || '').slice(0, 500));
      throw new Error(`LLM HTTP ${response.status}`);
    }

    const text = cleanFortuneText(response.json?.choices?.[0]?.message?.content);
    if (!text) {
      throw new Error('Empty LLM response');
    }

    return { text, source: 'ai' };
  } catch (err) {
    console.error('OpenAI request failed:', err.message);
    return { text: personalizeFallback(userData), source: 'fallback' };
  }
}

app.post('/api/create-payment', async (req, res) => {
  try {
    const { name, gender, question, email } = normalizeFormInput(req.body);

    if (RECEIPT_ENABLED && !DEMO_MODE && !email) {
      return res.status(400).json({
        success: false,
        error: 'Укажите email — на него отправим чек об оплате.',
      });
    }

    const orderId = `raskusi-${Date.now()}-${uuidv4().slice(0, 8)}`;

    orders.set(orderId, {
      orderId,
      name,
      gender,
      question,
      email,
      status: 'pending',
      createdAt: Date.now(),
    });

    if (DEMO_MODE) {
      const paymentURL = `${BASE_URL}/demo-pay.html?orderId=${encodeURIComponent(orderId)}`;
      return res.json({
        success: true,
        orderId,
        PaymentURL: paymentURL,
        demo: true,
      });
    }

    const initParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      Amount: AMOUNT_KOPECKS,
      OrderId: orderId,
      Description: RECEIPT_ITEM_NAME.slice(0, 250),
      SuccessURL: `${BASE_URL}/?orderId=${encodeURIComponent(orderId)}&status=success`,
      FailURL: `${BASE_URL}/?orderId=${encodeURIComponent(orderId)}&status=fail`,
      NotificationURL: `${BASE_URL}/api/payment-webhook`,
    };

    if (RECEIPT_ENABLED) {
      // Receipt is excluded from Token calculation by generateTinkoffToken.
      initParams.Receipt = buildReceipt(email);
    }

    initParams.Token = generateTinkoffToken(initParams, TINKOFF_SECRET_PASSWORD);

    let tinkoffResponse;
    try {
      tinkoffResponse = await requestJson(TINKOFF_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: initParams,
        timeoutMs: 20000,
      });
    } catch (fetchErr) {
      orders.delete(orderId);
      console.error('Tinkoff fetch failed:', fetchErr);
      return res.status(502).json({
        success: false,
        error: 'Не удалось связаться с платёжным шлюзом. Попробуйте позже.',
        detail: fetchErr.message,
      });
    }

    if (!tinkoffResponse.ok) {
      orders.delete(orderId);
      console.error(
        'Tinkoff HTTP error:',
        tinkoffResponse.status,
        String(tinkoffResponse.text || '').slice(0, 500)
      );
      return res.status(502).json({
        success: false,
        error: 'Не удалось связаться с платёжным шлюзом. Попробуйте позже.',
        detail: `HTTP ${tinkoffResponse.status}`,
      });
    }

    const data = tinkoffResponse.json || {};

    if (!data.Success || !data.PaymentURL) {
      orders.delete(orderId);
      console.error('Tinkoff Init failed:', data);
      return res.status(502).json({
        success: false,
        error: data.Message || data.Details || 'Платёж не создан. Проверьте настройки терминала.',
        detail: data.ErrorCode ? `ErrorCode ${data.ErrorCode}` : undefined,
      });
    }

    const order = orders.get(orderId);
    if (order) {
      order.paymentId = data.PaymentId;
      orders.set(orderId, order);
    }

    return res.json({
      success: true,
      orderId,
      PaymentURL: data.PaymentURL,
      PaymentId: data.PaymentId,
    });
  } catch (err) {
    console.error('create-payment error:', err);
    return res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка при создании платежа.',
      detail: err.message,
    });
  }
});

app.post('/api/payment-webhook', (req, res) => {
  try {
    const payload = req.body || {};

    if (!verifyTinkoffToken(payload)) {
      console.warn('Webhook: invalid token');
      return res.status(403).send('Forbidden');
    }

    const orderId = payload.OrderId;
    const status = String(payload.Status || '').toUpperCase();

    if (!orderId || !orders.has(orderId)) {
      // Acknowledge unknown/expired orders to stop retries
      return res.status(200).send('OK');
    }

    if (status === 'AUTHORIZED' || status === 'CONFIRMED') {
      const order = orders.get(orderId);
      order.status = 'paid';
      if (payload.PaymentId) order.paymentId = payload.PaymentId;
      orders.set(orderId, order);
    }

    return res.status(200).send('OK');
  } catch (err) {
    console.error('webhook error:', err);
    return res.status(500).send('Error');
  }
});

/** Demo-only: mark order paid after simulated checkout */
app.post('/api/demo-confirm', (req, res) => {
  if (!DEMO_MODE) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }

  const orderId = req.body?.orderId;
  if (!orderId || !orders.has(orderId)) {
    return res.status(404).json({ success: false, error: 'Заказ не найден' });
  }

  const order = orders.get(orderId);
  order.status = 'paid';
  orders.set(orderId, order);

  return res.json({ success: true, orderId });
});

app.get('/api/get-fortune', async (req, res) => {
  try {
    const orderId = typeof req.query.orderId === 'string' ? req.query.orderId : '';

    if (!orderId || !orders.has(orderId)) {
      return res.status(404).json({
        success: false,
        error: 'Заказ не найден или уже использован.',
      });
    }

    const order = orders.get(orderId);

    if (order.status !== 'paid') {
      return res.status(403).json({
        success: false,
        error: 'Оплата ещё не подтверждена.',
        status: order.status,
      });
    }

    const result = await generateFortune({
      name: order.name,
      gender: order.gender,
      question: order.question,
    });

    if (isRefusalFortune(result.text)) {
      order.status = 'retry';
      orders.set(orderId, order);
      return res.json({
        success: true,
        fortune: result.text,
        source: result.source,
        canRetry: true,
        orderId,
      });
    }

    orders.delete(orderId);

    return res.json({
      success: true,
      fortune: result.text,
      source: result.source,
      canRetry: false,
      orderId,
    });
  } catch (err) {
    console.error('get-fortune error:', err);
    return res.status(500).json({
      success: false,
      error: 'Не удалось получить предсказание. Попробуйте позже.',
    });
  }
});

/** Free re-ask after paid refusal — no second charge */
app.post('/api/retry-fortune', async (req, res) => {
  try {
    const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId : '';
    if (!orderId || !orders.has(orderId)) {
      return res.status(404).json({
        success: false,
        error: 'Повтор недоступен. Оформите новое предсказание.',
      });
    }

    const order = orders.get(orderId);
    if (order.status !== 'retry') {
      return res.status(403).json({
        success: false,
        error: 'Повторный вопрос без оплаты недоступен для этого заказа.',
      });
    }

    const next = normalizeFormInput(req.body);
    if (next.name) order.name = next.name;
    if (next.gender) order.gender = next.gender;
    order.question = next.question;
    order.status = 'paid';
    orders.set(orderId, order);

    const result = await generateFortune({
      name: order.name,
      gender: order.gender,
      question: order.question,
    });

    if (isRefusalFortune(result.text)) {
      order.status = 'retry';
      orders.set(orderId, order);
      return res.json({
        success: true,
        fortune: result.text,
        source: result.source,
        canRetry: true,
        orderId,
      });
    }

    orders.delete(orderId);

    return res.json({
      success: true,
      fortune: result.text,
      source: result.source,
      canRetry: false,
      orderId,
    });
  } catch (err) {
    console.error('retry-fortune error:', err);
    return res.status(500).json({
      success: false,
      error: 'Не удалось получить предсказание. Попробуйте позже.',
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    demoMode: DEMO_MODE,
    openaiConfigured: AI_ENABLED,
    model: AI_ENABLED ? OPENAI_MODEL : null,
    openaiBaseUrl: OPENAI_BASE_URL,
    tinkoffKeyLength: TINKOFF_TERMINAL_KEY.length,
    tinkoffPasswordLength: TINKOFF_SECRET_PASSWORD.length,
    baseUrl: BASE_URL,
    insecureTls: INSECURE_TLS,
    receiptEnabled: RECEIPT_ENABLED,
    taxation: TINKOFF_TAXATION,
  });
});

// SPA / unknown paths → home (payment return URLs keep query string client-side)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  sendPublicHtml(res, 'index.html');
});

// Cleanup stale pending orders (1 hour)
setInterval(() => {
  const now = Date.now();
  for (const [id, order] of orders.entries()) {
    if (now - order.createdAt > 60 * 60 * 1000) {
      orders.delete(id);
    }
  }
}, 15 * 60 * 1000).unref();

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Раскуси listening on http://0.0.0.0:${PORT}`);
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`DEMO_MODE=${DEMO_MODE}`);
  console.log(`AI_ENABLED=${AI_ENABLED} model=${OPENAI_MODEL}`);
  console.log(`INSECURE_TLS=${INSECURE_TLS}`);
});
