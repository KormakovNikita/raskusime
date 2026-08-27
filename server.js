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
const { orders, payments, flush: flushStore } = require('./store');

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
const TINKOFF_CANCEL_URL = 'https://securepay.tinkoff.ru/v2/Cancel';
const AMOUNT_KOPECKS = 2900;
const RECEIPT_ENABLED = process.env.RECEIPT_ENABLED !== 'false';
const TINKOFF_TAXATION = process.env.TINKOFF_TAXATION || 'usn_income';
const RECEIPT_TAX = process.env.RECEIPT_TAX || 'none';
const RECEIPT_ITEM_NAME = process.env.RECEIPT_ITEM_NAME || 'Предсказание Раскуси';
const REFUND_ADMIN_KEY = process.env.REFUND_ADMIN_KEY || '';
const YANDEX_METRIKA_ID = (process.env.YANDEX_METRIKA_ID || '').trim();
const PAYMENT_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const FULFILLED_RETENTION_MS = 72 * 60 * 60 * 1000;
const PENDING_RETENTION_MS = 60 * 60 * 1000;
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
const TINKOFF_IS_DEMO_KEY = /DEMO/i.test(TINKOFF_TERMINAL_KEY);
const TINKOFF_MODE = DEMO_MODE ? 'demo' : TINKOFF_IS_DEMO_KEY ? 'test' : 'live';

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

/** @type {import('./store').orders} orders bucket */
/** @type {import('./store').payments} payments bucket */

function rememberPayment(record) {
  if (!record?.paymentId) return;
  payments.set(String(record.paymentId), {
    orderId: record.orderId,
    paymentId: String(record.paymentId),
    email: record.email || '',
    amount: record.amount || AMOUNT_KOPECKS,
    status: record.status || 'created',
    createdAt: record.createdAt || Date.now(),
    refundedAt: record.refundedAt,
  });
}

function findPayment({ paymentId, orderId }) {
  if (paymentId && payments.has(String(paymentId))) {
    return payments.get(String(paymentId));
  }
  if (orderId) {
    for (const payment of payments.values()) {
      if (payment.orderId === orderId) return payment;
    }
  }
  return null;
}

function saveOrder(orderId, patch) {
  const prev = orders.get(orderId) || { orderId, createdAt: Date.now() };
  orders.set(orderId, { ...prev, ...patch, orderId });
}

function markOrderFulfilled(order) {
  saveOrder(order.orderId, {
    status: 'fulfilled',
    fortuneText: order.fortuneText,
    fortuneSource: order.fortuneSource,
    fulfilledAt: Date.now(),
    name: order.name,
    gender: order.gender,
    question: order.question,
    email: order.email,
    paymentId: order.paymentId,
    createdAt: order.createdAt,
  });
}

function buildMetrikaScript() {
  if (!YANDEX_METRIKA_ID || !/^\d+$/.test(YANDEX_METRIKA_ID)) return '';
  return `<script type="text/javascript">
   (function(m,e,t,r,i,k,a){m[i]=m[i]||function(){(m[i].a=m[i].a||[]).push(arguments)};
   m[i].l=1*new Date();
   for (var j = 0; j < document.scripts.length; j++) {if (document.scripts[j].src === r) { return; }}
   k=e.createElement(t),a=e.getElementsByTagName(t)[0],k.async=1,k.src=r,a.parentNode.insertBefore(k,a)})
   (window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");
   ym(${YANDEX_METRIKA_ID}, "init", { clickmap:true, trackLinks:true, accurateTrackBounce:true, webvisor:true });
</script>
<noscript><div><img src="https://mc.yandex.ru/watch/${YANDEX_METRIKA_ID}" style="position:absolute; left:-9999px;" alt="" /></div></noscript>`;
}

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
  return fs
    .readFileSync(filePath, 'utf8')
    .split('{{BASE_URL}}')
    .join(BASE_URL)
    .split('{{YANDEX_METRIKA_SCRIPT}}')
    .join(buildMetrikaScript());
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

    saveOrder(orderId, {
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
      saveOrder(orderId, { paymentId: data.PaymentId });
    }

    rememberPayment({
      orderId,
      paymentId: data.PaymentId,
      email,
      amount: AMOUNT_KOPECKS,
      status: 'created',
      createdAt: Date.now(),
    });

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
      if (!order) return res.status(200).send('OK');

      saveOrder(orderId, {
        status: 'paid',
        paymentId: payload.PaymentId || order.paymentId,
      });

      const paymentId = payload.PaymentId || order.paymentId;
      if (paymentId) {
        const existing = findPayment({ paymentId, orderId });
        rememberPayment({
          orderId,
          paymentId,
          email: order.email || existing?.email || '',
          amount: existing?.amount || AMOUNT_KOPECKS,
          status: 'paid',
          createdAt: existing?.createdAt || order.createdAt || Date.now(),
        });
      }
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
  saveOrder(orderId, { status: 'paid' });

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

    if (order.status === 'fulfilled' && order.fortuneText) {
      return res.json({
        success: true,
        fortune: order.fortuneText,
        source: order.fortuneSource || 'cached',
        canRetry: false,
        orderId,
        recovered: true,
      });
    }

    if (order.status !== 'paid' && order.status !== 'retry') {
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
      saveOrder(orderId, { status: 'retry' });
      return res.json({
        success: true,
        fortune: result.text,
        source: result.source,
        canRetry: true,
        orderId,
      });
    }

    markOrderFulfilled({
      ...order,
      fortuneText: result.text,
      fortuneSource: result.source,
    });

    if (order.paymentId) {
      const existing = findPayment({ paymentId: order.paymentId, orderId });
      rememberPayment({
        orderId,
        paymentId: order.paymentId,
        email: order.email || existing?.email || '',
        amount: existing?.amount || AMOUNT_KOPECKS,
        status: 'fulfilled',
        createdAt: existing?.createdAt || order.createdAt || Date.now(),
      });
    }

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

    let order = orders.get(orderId);
    if (order.status !== 'retry') {
      return res.status(403).json({
        success: false,
        error: 'Повторный вопрос без оплаты недоступен для этого заказа.',
      });
    }

    const next = normalizeFormInput(req.body);
    saveOrder(orderId, {
      name: next.name || order.name,
      gender: next.gender || order.gender,
      question: next.question,
      status: 'paid',
    });
    order = orders.get(orderId);

    const result = await generateFortune({
      name: order.name,
      gender: order.gender,
      question: order.question,
    });

    if (isRefusalFortune(result.text)) {
      saveOrder(orderId, { status: 'retry' });
      return res.json({
        success: true,
        fortune: result.text,
        source: result.source,
        canRetry: true,
        orderId,
      });
    }

    markOrderFulfilled({
      ...order,
      fortuneText: result.text,
      fortuneSource: result.source,
    });

    if (order.paymentId) {
      const existing = findPayment({ paymentId: order.paymentId, orderId });
      rememberPayment({
        orderId,
        paymentId: order.paymentId,
        email: order.email || existing?.email || '',
        amount: existing?.amount || AMOUNT_KOPECKS,
        status: 'fulfilled',
        createdAt: existing?.createdAt || order.createdAt || Date.now(),
      });
    }

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

/**
 * Full refund via T-Bank Cancel.
 * For online cash register full refund — do NOT send Receipt (bank forms return check).
 * Auth: header X-Refund-Key must match REFUND_ADMIN_KEY.
 */
app.post('/api/refund', async (req, res) => {
  try {
    if (isPlaceholder(REFUND_ADMIN_KEY)) {
      return res.status(404).json({ success: false, error: 'Not found' });
    }

    const provided =
      req.get('x-refund-key') ||
      (typeof req.body?.adminKey === 'string' ? req.body.adminKey : '');
    if (!provided || provided !== REFUND_ADMIN_KEY) {
      return res.status(403).json({ success: false, error: 'Forbidden' });
    }

    if (DEMO_MODE) {
      return res.status(400).json({
        success: false,
        error: 'Возврат через T-Bank недоступен в демо-режиме.',
      });
    }

    const paymentId =
      typeof req.body?.paymentId === 'string' ? req.body.paymentId.trim() : '';
    const orderId = typeof req.body?.orderId === 'string' ? req.body.orderId.trim() : '';
    const payment = findPayment({ paymentId, orderId });

    const resolvedPaymentId = paymentId || payment?.paymentId;
    if (!resolvedPaymentId) {
      return res.status(404).json({
        success: false,
        error: 'Платёж не найден. Укажите PaymentId из кабинета Т-Банка.',
      });
    }

    if (payment?.status === 'refunded') {
      return res.json({
        success: true,
        alreadyRefunded: true,
        paymentId: resolvedPaymentId,
        orderId: payment.orderId,
      });
    }

    const cancelParams = {
      TerminalKey: TINKOFF_TERMINAL_KEY,
      PaymentId: String(resolvedPaymentId),
    };
    cancelParams.Token = generateTinkoffToken(cancelParams, TINKOFF_SECRET_PASSWORD);

    let cancelResponse;
    try {
      cancelResponse = await requestJson(TINKOFF_CANCEL_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: cancelParams,
        timeoutMs: 20000,
      });
    } catch (err) {
      console.error('Tinkoff Cancel fetch failed:', err);
      return res.status(502).json({
        success: false,
        error: 'Не удалось связаться с платёжным шлюзом.',
        detail: err.message,
      });
    }

    const data = cancelResponse.json || {};
    if (!cancelResponse.ok || !data.Success) {
      console.error('Tinkoff Cancel failed:', data);
      return res.status(502).json({
        success: false,
        error: data.Message || data.Details || 'Возврат не выполнен.',
        detail: data.ErrorCode ? `ErrorCode ${data.ErrorCode}` : undefined,
        status: data.Status,
      });
    }

    rememberPayment({
      orderId: payment?.orderId || orderId || '',
      paymentId: resolvedPaymentId,
      email: payment?.email || '',
      amount: payment?.amount || AMOUNT_KOPECKS,
      status: 'refunded',
      createdAt: payment?.createdAt || Date.now(),
      refundedAt: Date.now(),
    });

    if (payment?.orderId && orders.has(payment.orderId)) {
      orders.delete(payment.orderId);
    }

    return res.json({
      success: true,
      paymentId: resolvedPaymentId,
      orderId: payment?.orderId || orderId || null,
      status: data.Status,
    });
  } catch (err) {
    console.error('refund error:', err);
    return res.status(500).json({
      success: false,
      error: 'Внутренняя ошибка при возврате.',
      detail: err.message,
    });
  }
});

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true,
    demoMode: DEMO_MODE,
    tinkoffMode: TINKOFF_MODE,
    openaiConfigured: AI_ENABLED,
    model: AI_ENABLED ? OPENAI_MODEL : null,
    openaiBaseUrl: OPENAI_BASE_URL,
    tinkoffKeyLength: TINKOFF_TERMINAL_KEY.length,
    tinkoffPasswordLength: TINKOFF_SECRET_PASSWORD.length,
    baseUrl: BASE_URL,
    insecureTls: INSECURE_TLS,
    receiptEnabled: RECEIPT_ENABLED,
    taxation: TINKOFF_TAXATION,
    refundApiEnabled: !isPlaceholder(REFUND_ADMIN_KEY),
    metrikaEnabled: Boolean(YANDEX_METRIKA_ID),
    metrikaId: YANDEX_METRIKA_ID || null,
    persistence: 'json-file',
  });
});

// SPA / unknown paths → home (payment return URLs keep query string client-side)
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/')) {
    return res.status(404).json({ success: false, error: 'Not found' });
  }
  sendPublicHtml(res, 'index.html');
});

// Cleanup stale orders and old payment records
setInterval(() => {
  const now = Date.now();
  for (const [id, order] of orders.entries()) {
    const age = now - (order.createdAt || 0);
    if (order.status === 'pending' && age > PENDING_RETENTION_MS) {
      orders.delete(id);
      continue;
    }
    if (order.status === 'fulfilled' && order.fulfilledAt && now - order.fulfilledAt > FULFILLED_RETENTION_MS) {
      orders.delete(id);
    }
  }
  for (const [id, payment] of payments.entries()) {
    if (now - payment.createdAt > PAYMENT_RETENTION_MS) {
      payments.delete(id);
    }
  }
}, 15 * 60 * 1000).unref();

process.on('SIGINT', () => {
  flushStore();
  process.exit(0);
});
process.on('SIGTERM', () => {
  flushStore();
  process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
  console.log(`Раскуси listening on http://0.0.0.0:${PORT}`);
  console.log(`BASE_URL=${BASE_URL}`);
  console.log(`DEMO_MODE=${DEMO_MODE} tinkoffMode=${TINKOFF_MODE}`);
  console.log(`AI_ENABLED=${AI_ENABLED} model=${OPENAI_MODEL}`);
  console.log(`INSECURE_TLS=${INSECURE_TLS}`);
  console.log(`REFUND_API=${!isPlaceholder(REFUND_ADMIN_KEY)}`);
  console.log(`METRIKA=${YANDEX_METRIKA_ID ? 'on' : 'off'}`);
});
