require('dotenv').config();

const crypto = require('crypto');
const path = require('path');
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

/** @type {Map<string, { orderId: string, name: string, gender: string, question: string, status: string, paymentId?: string, createdAt: number }>} */
const orders = new Map();

const SYSTEM_PROMPT = `Ты — генератор мудрых и лаконичных предсказаний в стиле традиционных "китайских печений с запиской". Твоя задача — давать пользователю емкие, глубокие ответы, которые помогают ему заглянуть в себя.

1. ТВОЯ РОЛЬ И СТИЛЬ
- Формулируй ответы не как мистическое предвидение будущего, а как точные психологические подсказки, метафоры и философские ориентиры.
- Твой тон: поддерживающий, вдохновляющий, емкий и прямой.
- Пиши только текстом. Полностью избегай любых эмодзи (смайликов).
- Пиши коротко, емко и по сути. Избегай «воды» и лишних вступлений.

2. СТРУКТУРА ОТВЕТА
Каждый ответ должен состоять строго из трех блоков, разделенных пустой строкой. Никаких лишних слов или приветствий. Сразу выводи блоки:
[БЛОК 1: СУТЬ И МЕТАФОРA] (1-2 предложения, раскрывающие суть ситуации через метафору печенья. Если пользователь указал Имя, Пол или Вопрос — адаптируй под контекст).
[БЛОК 2: ПСИХОЛОГИЧЕСКИЙ СОВЕТ] (1-2 предложения. Практический совет, на что обратить внимание в мыслях или поведении).
[БЛОК 3: ДЕЙСТВИЕ] (Одно короткое, конкретное действие на сегодня).

3. КРИТИЧЕСКИЕ ОГРАНИЧЕНИЯ И БЕЗОПАСНОСТЬ
- Строго запрещено упоминать смерть, болезни, насилие, катастрофы или финансовый крах.
- Если вопрос деструктивный, опасный или трешовый, ты ОБЯЗАН выдать стандартный отказ: "К сожалению, печенье не может ответить на этот вопрос. Попробуйте сформулировать запрос иначе, сфокусировавшись на своем внутреннем состоянии или целях."`;

app.use(cors());
app.use(express.json({ limit: '100kb' }));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

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
  const parts = [];
  if (name) parts.push(`Имя: ${name}`);
  if (gender === 'm' || gender === 'f') {
    parts.push(`Пол: ${gender === 'm' ? 'мужской' : 'женский'}`);
  }
  if (question && question.trim()) {
    parts.push(`Вопрос: ${question.trim()}`);
  } else {
    parts.push('Вопрос не задан — дай случайное универсальное предсказание.');
  }
  return parts.join('\n');
}

const FALLBACK_FORTUNES = [
  {
    block1:
      'Печенье ломается там, где уже созрела трещина: ты давно чувствуешь, что пора выбрать направление, а не ждать идеального знака.',
    block2:
      'Обрати внимание на мысли, в которых ты откладываешь решение «на потом». Часто это маскирует страх ошибиться, а не отсутствие ясности.',
    block3: 'Сегодня запиши одно решение, которое ты готов проверить на практике в ближайшие три дня.',
  },
  {
    block1:
      'Как начинка скрыта до разлома, так и твой ответ уже внутри — он проявляется, когда ты перестаешь спрашивать всех вокруг.',
    block2:
      'Заметь, кому ты отдаёшь право оценивать твои шаги. Внешний шум редко помогает услышать собственную меру.',
    block3: 'Сегодня сделай один шаг без согласования с другими — маленький, но полностью твой.',
  },
  {
    block1:
      'Печенье хрупкое снаружи и плотное внутри: твоя мягкость не слабость, а способ сохранить суть под давлением обстоятельств.',
    block2:
      'Проверь, где ты путаешь усталость с безразличием. Иногда достаточно восстановить границы, чтобы вернулась ясность.',
    block3: 'Сегодня заверши одно незакрытое дело длиной не больше тридцати минут.',
  },
  {
    block1:
      'Записка коротка, потому что правда не нуждается в украшениях: тебе уже достаточно данных, чтобы двигаться дальше.',
    block2:
      'Обрати внимание на привычку перепроверять очевидное. Сомнения полезны до точки выбора — после неё они лишь тормозят.',
    block3: 'Сегодня назови вслух одно намерение и сделай первый конкретный шаг к нему.',
  },
];

function personalizeFallback({ name, gender, question }) {
  const base = FALLBACK_FORTUNES[Math.floor(Math.random() * FALLBACK_FORTUNES.length)];
  let block1 = base.block1;

  if (name) {
    block1 = `${name}, ${block1.charAt(0).toLowerCase()}${block1.slice(1)}`;
  }
  if (question && question.trim()) {
    block1 = `${block1} Твой вопрос о «${question.trim().slice(0, 80)}» уже содержит намёк на то, что для тебя важно.`;
  }
  if (gender === 'f') {
    // subtle address tweak kept minimal to avoid rewriting tone
  }

  return [block1, base.block2, base.block3].join('\n\n');
}

async function generateFortune(userData) {
  if (!AI_ENABLED) {
    console.warn('OPENAI_API_KEY is missing — using local fallback fortune');
    return { text: personalizeFallback(userData), source: 'fallback' };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);

  try {
    const response = await fetch(`${OPENAI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        temperature: 0.9,
        max_tokens: 500,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: buildUserPrompt(userData) },
        ],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errText = await response.text().catch(() => '');
      console.error('OpenAI error:', response.status, errText.slice(0, 500));
      throw new Error(`LLM HTTP ${response.status}`);
    }

    const data = await response.json();
    const text = data?.choices?.[0]?.message?.content?.trim();
    if (!text) {
      throw new Error('Empty LLM response');
    }

    return { text, source: 'ai' };
  } catch (err) {
    console.error('OpenAI request failed:', err.message);
    return { text: personalizeFallback(userData), source: 'fallback' };
  } finally {
    clearTimeout(timeout);
  }
}

app.post('/api/create-payment', async (req, res) => {
  try {
    const name = typeof req.body?.name === 'string' ? req.body.name.trim().slice(0, 80) : '';
    const gender = req.body?.gender === 'm' || req.body?.gender === 'f' ? req.body.gender : '';
    const question =
      typeof req.body?.question === 'string' ? req.body.question.trim().slice(0, 500) : '';

    const orderId = `raskusi-${Date.now()}-${uuidv4().slice(0, 8)}`;

    orders.set(orderId, {
      orderId,
      name,
      gender,
      question,
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
      Description: 'Предсказание Раскуси',
      SuccessURL: `${BASE_URL}/?orderId=${encodeURIComponent(orderId)}&status=success`,
      FailURL: `${BASE_URL}/?orderId=${encodeURIComponent(orderId)}&status=fail`,
      NotificationURL: `${BASE_URL}/api/payment-webhook`,
    };

    initParams.Token = generateTinkoffToken(initParams, TINKOFF_SECRET_PASSWORD);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 20000);

    let tinkoffResponse;
    try {
      tinkoffResponse = await fetch(TINKOFF_API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(initParams),
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    if (!tinkoffResponse.ok) {
      orders.delete(orderId);
      return res.status(502).json({
        success: false,
        error: 'Не удалось связаться с платёжным шлюзом. Попробуйте позже.',
      });
    }

    const data = await tinkoffResponse.json();

    if (!data.Success || !data.PaymentURL) {
      orders.delete(orderId);
      console.error('Tinkoff Init failed:', data);
      return res.status(502).json({
        success: false,
        error: data.Message || data.Details || 'Платёж не создан. Проверьте настройки терминала.',
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

    orders.delete(orderId);

    return res.json({
      success: true,
      fortune: result.text,
      source: result.source,
    });
  } catch (err) {
    console.error('get-fortune error:', err);
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
  });
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
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
});
