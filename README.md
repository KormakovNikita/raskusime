# Раскуси (Raskusi)

Одностраничный сайт лаконичных психологических предсказаний в стиле китайского печенья с запиской. **Бесплатно** — без оплаты и регистрации.

## Стек

- **Frontend:** HTML5, Tailwind CSS (CDN), Vanilla JavaScript
- **Backend:** Node.js + Express
- **Платежи:** T-Bank (Tinkoff) API v2
- **ИИ:** OpenAI Chat Completions (с локальным fallback)

## Быстрый старт

```bash
cp .env.example .env
npm install
npm start
```

По умолчанию в `.env.example` указан `PORT=3000`. В этой среде сервер может слушать другой порт (например `3847`) — смотрите значение `PORT` в вашем `.env`.

Для разработки с автоперезапуском:

```bash
npm run dev
```

## Переменные окружения

| Переменная | Описание |
|---|---|
| `PORT` | Порт сервера (по умолчанию `3847`) |
| `BASE_URL` | Публичный URL приложения (для SuccessURL / NotificationURL) |
| `TINKOFF_TERMINAL_KEY` | Ключ терминала Т-Банка |
| `TINKOFF_SECRET_PASSWORD` | Пароль терминала для подписи Token |
| `OPENAI_API_KEY` | Ключ LLM (ProxyAPI / OpenAI / другой совместимый) |
| `OPENAI_MODEL` | Модель Chat Completions (`gpt-4o-mini` и т.п.) |
| `OPENAI_BASE_URL` | Базовый URL API (совместимый с OpenAI Chat Completions) |
| `DEMO_MODE` | `true` — симуляция оплаты без реального эквайринга |
| `INSECURE_TLS` | `true` — отключить проверку SSL (только если в логах `SELF_SIGNED_CERT_IN_CHAIN`) |
| `RECEIPT_ENABLED` | `true` — передавать объект `Receipt` в Init для онлайн-кассы |
| `TINKOFF_TAXATION` | СНО в чеке: `usn_income` / `usn_income_outcome` / `osn` / `patent` / `esn` |
| `RECEIPT_TAX` | Ставка НДС в позиции: для УСН без НДС — `none` |
| `RECEIPT_ITEM_NAME` | Название услуги в чеке |
| `REFUND_ADMIN_KEY` | Секрет для `POST /api/refund` (полный возврат через Cancel) |
| `YANDEX_METRIKA_ID` | ID счётчика Яндекс.Метрики (только цифры) |

### Возврат средств

В оферте возврат описан через обращение на `support@…`. Технически полный возврат — метод Т-Банка **Cancel** без `Receipt` (чек возврата касса сформирует сама).

1. В `.env` задайте длинный секрет: `REFUND_ADMIN_KEY=...`
2. `pm2 restart raskusi`
3. Вернуть платёж:
   ```bash
   curl -s -X POST https://raskusime.ru/api/refund \
     -H 'Content-Type: application/json' \
     -H 'X-Refund-Key: ваш_секрет' \
     -d '{"paymentId":"9129913377"}'
   ```
   Можно вместо `paymentId` передать `orderId`, если платёж ещё есть в памяти сервера (до 7 дней и до рестарта PM2).

PaymentId также виден в кабинете Т-Банка.

Если `OPENAI_API_KEY` не задан, сервер временно отдаёт локальный шаблон. После добавления ключа перезапустите сервер — предсказания пойдут через LLM.

### LLM из РФ (ProxyAPI)

Прямой OpenAI с российских VPS часто отвечает `403 unsupported_country_region_territory`. ProxyAPI даёт тот же API с оплатой в рублях.

1. Зарегистрируйтесь на [proxyapi.ru](https://proxyapi.ru), пополните баланс, создайте API key.
2. В `.env` на VPS:
   ```env
   OPENAI_API_KEY=ваш_ключ_proxyapi
   OPENAI_BASE_URL=https://api.proxyapi.ru/openai/v1
   OPENAI_MODEL=gpt-4o-mini
   ```
3. `pm2 restart raskusi`

Если ключи Т-Банка не заданы (или оставлены плейсхолдеры), сервер автоматически работает в **демо-режиме**: платёж подтверждается на локальной странице без списания средств.

## API

### `POST /api/create-payment`

Принимает `{ name?, gender?, question? }`, создаёт заказ, инициирует платёж в Т-Банке (или демо) и возвращает `PaymentURL`.

### `POST /api/payment-webhook`

Вебхук Т-Банка. Проверяет Token; при `AUTHORIZED` / `CONFIRMED` помечает заказ как `paid`.

### `GET /api/get-fortune?orderId=...`

Если заказ оплачен — генерирует предсказание через LLM. Готовая записка сохраняется на 72 часа: можно вернуться по ссылке с `orderId` после оплаты.

## Сценарий пользователя

1. Заполняет необязательные поля и нажимает «Раскусить за 29 ₽ через T-Pay».
2. Переходит на страницу оплаты Т-Банка (или демо).
3. После успешной оплаты возвращается на сайт: печенье разламывается, появляется записка с тремя блоками текста.
4. Кнопка «Получить еще одно предсказание» возвращает к началу.

## Продакшен

1. Укажите **боевые** `TINKOFF_*` (ключ без суффикса `DEMO`) и `OPENAI_API_KEY`.
2. Установите `DEMO_MODE=false`.
3. Пропишите публичный `BASE_URL` (HTTPS), доступный для вебхуков Т-Банка.
4. В личном кабинете терминала: Notification URL → `{BASE_URL}/api/payment-webhook`.
5. Проверьте `/api/health`: `"tinkoffMode":"live"`, `"demoMode":false`.
6. `YANDEX_METRIKA_ID=112027032` — цели для Яндекс.Метрики и Директа (тип **JavaScript-событие**, идентификатор = имя цели):

| Идентификатор | Когда срабатывает | Для Директа |
|---|---|---|
| `landing` | Первый визит на главную | Охват |
| `view_form` | Форма оплаты в зоне видимости | Вовлечение |
| `scroll_50` | Прокрутка 50% страницы | Вовлечение |
| `scroll_bottom` | Доскролл до конца | Вовлечение |
| `view_examples` | Блок «Как выглядит записка» | Вовлечение |
| `view_how` | Блок «Как это работает» | Вовлечение |
| `view_about` | Блок «Что такое Раскуси» | Вовлечение |
| `view_faq` | Блок FAQ | Вовлечение |
| `form_start` | Первый фокус в поле формы | Микроконверсия |
| `form_name_filled` | Введено имя | Микроконверсия |
| `form_gender_selected` | Выбран пол | Микроконверсия |
| `form_question_filled` | Введён вопрос | Микроконверсия |
| `form_email_valid` | Валидный email | Микроконверсия |
| `consent_checked` | Согласие на ПДн | Микроконверсия |
| `checkout_start` | Начало оформления (клик оплатить) | Воронка |
| `pay_click` | Клик «Оплатить» после проверки формы | Воронка |
| `pay_create_start` | Создание платежа на сервере | Воронка |
| `pay_redirect` | Переход на страницу T-Pay | **Ключевая микроконверсия** |
| `pay_create_error` | Ошибка создания платежа | Диагностика |
| `pay_return` | Возврат с оплаты на сайт | Воронка |
| `pay_poll_start` | Ожидание подтверждения оплаты | Воронка |
| `pay_success` | Успешная оплата + предсказание (с `order_price`) | **Главная конверсия** |
| `fortune_received` | То же, что pay_success (дубль для совместимости) | Конверсия |
| `fortune_shown` | Анимация записки показана | Постконверсия |
| `fortune_refusal` | Отказ печенья, предложен повтор | Диагностика |
| `pay_fail` | Возврат со статусом fail | Диагностика |
| `pay_poll_error` | Ошибка при получении предсказания | Диагностика |
| `retry_click` | «Спросить снова» без доплаты | Постконверсия |
| `retry_success` | Успешный повтор без доплаты | Постконверсия |
| `order_again_click` | «Получить ещё одно предсказание» | Повторная покупка |
| `faq_open` | Открыт пункт FAQ | Вовлечение |
| `footer_*_click` | Клики в футере | Вовлечение |

**E-commerce:** при `pay_success` в `dataLayer` уходит событие `purchase` (29 ₽). В Метрике включите **Электронная коммерция** → источник данных **dataLayer**.

**Яндекс.Директ:** в качестве цели оптимизации рекомендуется `pay_success` (или ecommerce «Покупка»). Для обучения на верх воронки — `pay_redirect` или `form_email_valid`.

## Монетизация: РСЯ (реклама на сайте)

Чтобы **показывать** рекламу Яндекса на raskusime.ru и получать доход (не путать с **покупкой** трафика в Директе):

1. Зарегистрируйтесь в [partner.yandex.ru](https://partner.yandex.ru/) → **Рекламная сеть Яндекса**.
2. **Добавить сайт** → `https://raskusime.ru` → дождитесь модерации (обычно 1–3 раб. дня).
3. **Создать блоки** (рекомендуемые форматы):
   - **Адаптивный блок** — между SEO-секциями (`YANDEX_RSYA_BLOCK_CONTENT`)
   - **Горизонтальный / адаптивный** — перед футером (`YANDEX_RSYA_BLOCK_FOOTER`)
4. Скопируйте **ID блока** вида `R-A-1234567-1` из кода блока в кабинете.
5. В `.env` на VPS:

```env
YANDEX_RSYA_BLOCK_CONTENT=R-A-XXXXXXX-1
YANDEX_RSYA_BLOCK_FOOTER=R-A-XXXXXXX-2
YANDEX_RSYA_ADS_TXT=yandex.com, ВАШ_ID, DIRECT, f08c47fec0942fa0
```

Строка `YANDEX_RSYA_ADS_TXT` — одна строка из кабинета Partner → сайт → **ads.txt**. Проверка: `https://raskusime.ru/ads.txt`

6. `pm2 restart raskusi` → `/api/health` → `"rsyaEnabled": true`.

**Важно:** реклама **не показывается** во время оплаты и показа записки (только на главной в SEO-зоне). Блоки не создавайте рядом с кнопкой «Оплатить» — это нарушает правила РСЯ.

7. SSL на VPS: `sudo bash scripts/fix-vps-ca.sh`, затем `INSECURE_TLS=false`.

Заказы и платежи сохраняются в `data/store.json` (переживают перезапуск PM2).

После `git pull` при изменении вёрстки: `npm install && npm run build:css && pm2 restart raskusi`.

## SEO — этап 1 (сделано)

Уже в коде:

- title / description / canonical / Open Graph / robots
- JSON-LD: WebSite, Organization, Product/Offer, FAQPage
- H1, блоки «Как это работает», «Что такое Раскуси», FAQ
- `robots.txt`, `sitemap.xml` (подставляют `BASE_URL`)
- страницы `/offer.html` и `/privacy.html`
- `noindex` для демо-оплаты и URL с `orderId`
- favicon.svg

## SEO — чеклист: домен и вебмастеры

Делайте по порядку. Пока пункта нет — к следующему не переходите.

### A. Домен и HTTPS

- [ ] **1. Выбрать домен**  
  Лучше короткий бренд: `raskusi.ru` / `raskusi.com`. Для РФ-аудитории предпочтителен `.ru`.
- [ ] **2. Купить домен** у регистратора (Timeweb, REG.RU, Cloudflare, Namecheap и т.п.).
- [ ] **3. Выбрать хостинг/VPS**, куда будет деплоиться этот Node/Express-проект  
  (или PaaS: Railway, Render, Fly.io, VPS с Nginx).
- [ ] **4. DNS**  
  - `A` / `AAAA` (или `CNAME`) на сервер  
  - решить: `raskusi.ru` **или** `www.raskusi.ru` как основной  
  - второй вариант сразу редиректить 301 на основной
- [ ] **5. HTTPS**  
  Let's Encrypt / Cloudflare Full (strict). Проверить:
  - `https://ваш-домен` открывается без предупреждений  
  - `http://` → 301 на `https://`
- [ ] **6. Прописать в `.env` на проде**
  ```env
  BASE_URL=https://ваш-домен
  DEMO_MODE=false
  ```
  Без завершающего `/`. После смены `BASE_URL` перезапустить сервер.
- [ ] **7. Проверить служебные URL**
  - `https://ваш-домен/robots.txt` — в Sitemap уже ваш домен, не localhost  
  - `https://ваш-домен/sitemap.xml` — все `<loc>` на https-домене  
  - `https://ваш-домен/offer.html` и `/privacy.html` открываются  
  - в исходнике главной `canonical` и `og:url` = ваш HTTPS
- [ ] **8. Т-Банк**  
  В кабинете терминала: Success / Fail / Notification URL на ваш `BASE_URL`  
  Notification: `https://ваш-домен/api/payment-webhook`

### B. Яндекс.Вебмастер (приоритет для РФ)

- [ ] **1.** Войти в [webmaster.yandex.ru](https://webmaster.yandex.ru)
- [ ] **2.** «Добавить сайт» → `https://ваш-домен`
- [ ] **3. Подтвердить права** (один способ):
  - meta-тег в `<head>` (скажите — добавлю в код), или  
  - HTML-файл в `/public`, или  
  - DNS TXT
- [ ] **4.** Указать **главное зеркало** (с www или без — как выбрали в DNS)
- [ ] **5.** Регион сайта (если спрашивает) — Россия / нужный город
- [ ] **6.** Отправить карту сайта: `https://ваш-домен/sitemap.xml`
- [ ] **7.** Дождаться обхода; проверить «Индексирование» → нет массовых 404/5xx
- [ ] **8.** (Опционально) подключить Яндекс.Метрику и связать с Вебмастером

### C. Google Search Console

- [ ] **1.** Войти в [search.google.com/search-console](https://search.google.com/search-console)
- [ ] **2.** Добавить ресурс типа **«Домен»** (через DNS TXT)  
  или **«URL-префикс»** `https://ваш-домен` (meta / файл / GA)
- [ ] **3.** Подтвердить владение
- [ ] **4.** Отправить sitemap: `https://ваш-домен/sitemap.xml`
- [ ] **5.** «Проверка URL» для главной → «Запросить индексирование»
- [ ] **6.** Через несколько дней смотреть Coverage / Page indexing: главная, оферта, privacy в индексе; `demo-pay` и URL с `orderId` — нет

### D. Быстрая проверка после подключения

- [ ] В режиме инкогнито сайт открывается по HTTPS
- [ ] `robots.txt` и `sitemap.xml` без localhost
- [ ] В Вебмастере/GSC sitemap в статусе «успешно» / «fetched»
- [ ] Нет редирект-цепочек длиннее 1 шага (http→https или www→apex)
- [ ] Оплата/вебхук Т-Банка ходят на боевой домен

### Что прислать агенту, когда домен готов

1. Итоговый URL (`https://...`)  
2. Нужен ли meta-тег подтверждения Яндекса/Google (пришлите строки — вставлю в `index.html`)  
3. Готовы ли реквизиты для оферты/политики  

После этого можно переходить к **этапу 2 SEO в коде** (скорость: убрать Tailwind CDN, шрифты) и OG-картинке 1200×630.

## SEO — позже

- Реквизиты в оферте и политике конфиденциальности  
- OG-картинка 1200×630 (PNG/JPG)  
- Этап 2: Core Web Vitals (Tailwind CDN → сборка, self-host шрифты)  
- Этап 3: контент/кластеры запросов
