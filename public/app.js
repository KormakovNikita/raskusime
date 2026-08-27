(() => {
  const $ = (id) => document.getElementById(id);

  const stageForm = $('stage-form');
  const stageLoader = $('stage-loader');
  const stageAgain = $('stage-again');
  const stageRetry = $('stage-retry');
  const loaderText = $('loader-text');
  const formError = $('form-error');
  const retryError = $('retry-error');
  const demoHint = $('demo-hint');
  const cookieStage = $('cookie-stage');
  const cookieWrap = $('cookie-wrap');
  const fortuneSlip = $('fortune-slip');
  const btnPay = $('btn-pay');
  const btnAgain = $('btn-again');
  const btnRetry = $('btn-retry');
  const inputName = $('input-name');
  const inputQuestion = $('input-question');
  const inputRetryQuestion = $('input-retry-question');
  const atmosphere = document.querySelector('.atmosphere');

  let selectedGender = '';
  let pollTimer = null;
  let activeOrderId = null;
  let retryOrderId = null;
  let flowGeneration = 0;
  let crackTimers = [];

  document.querySelectorAll('.gender-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedGender = btn.dataset.gender || '';
      document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
  });

  // Soft parallax for atmosphere
  if (atmosphere && !window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
    window.addEventListener(
      'pointermove',
      (event) => {
        const x = (event.clientX / window.innerWidth - 0.5) * 18;
        const y = (event.clientY / window.innerHeight - 0.5) * 14;
        atmosphere.style.setProperty('--parallax-x', `${x.toFixed(1)}px`);
        atmosphere.style.setProperty('--parallax-y', `${y.toFixed(1)}px`);
      },
      { passive: true }
    );
  }

  function showError(message) {
    formError.textContent = message;
    formError.classList.remove('hidden');
  }

  function clearError() {
    formError.textContent = '';
    formError.classList.add('hidden');
  }

  function showRetryError(message) {
    retryError.textContent = message;
    retryError.classList.remove('hidden');
  }

  function clearRetryError() {
    retryError.textContent = '';
    retryError.classList.add('hidden');
  }

  function clearPaymentParams() {
    history.replaceState({}, '', '/');
  }

  function clearCrackTimers() {
    crackTimers.forEach((id) => window.clearTimeout(id));
    crackTimers = [];
  }

  function later(ms, fn) {
    const id = window.setTimeout(fn, ms);
    crackTimers.push(id);
    return id;
  }

  function resetSlipHidden() {
    fortuneSlip.classList.remove('is-visible', 'relative', 'w-full', 'is-centered-reveal');
    fortuneSlip.classList.add(
      'absolute',
      'left-1/2',
      'top-1/2',
      '-translate-x-1/2',
      '-translate-y-1/2',
      'opacity-0',
      'pointer-events-none'
    );
    fortuneSlip.style.opacity = '';
  }

  function setStage(stage) {
    stageForm.classList.toggle('hidden', stage !== 'form');
    stageLoader.classList.toggle('hidden', stage !== 'loader');
    stageLoader.classList.toggle('flex', stage === 'loader');
    stageAgain.classList.toggle('hidden', stage !== 'fortune');
    stageRetry.classList.toggle('hidden', stage !== 'retry');

    if (stage === 'form') {
      clearCrackTimers();
      cookieWrap.classList.remove('is-cracking', 'is-revealed', 'is-impact');
      cookieStage.classList.remove('is-fortune');
      clearCrumbs();
      resetSlipHidden();
      ['fortune-block-1', 'fortune-block-2', 'fortune-block-3'].forEach((id) => {
        $(id).textContent = '';
      });
    }
  }

  function parseFortuneBlocks(text) {
    const cleaned = String(text || '')
      .replace(/\[БЛОК\s*\d+[^\]]*\]/gi, '')
      .trim();
    const parts = cleaned
      .split(/\n\s*\n/)
      .map((p) => p.trim())
      .filter(Boolean);

    if (parts.length >= 3) {
      return [parts[0], parts[1], parts.slice(2).join('\n\n')];
    }
    if (parts.length === 2) return [parts[0], parts[1], ''];
    if (parts.length === 1) return [parts[0], '', ''];
    return ['Предсказание временно недоступно.', 'Попробуйте ещё раз чуть позже.', ''];
  }

  function isRefusalText(text) {
    return /печенье не может ответить/i.test(String(text || ''));
  }

  function spawnCrumbs() {
    const layer = $('crumb-layer');
    if (!layer) return;
    layer.innerHTML = '';

    const count = 16;
    for (let i = 0; i < count; i += 1) {
      const crumb = document.createElement('span');
      crumb.className = 'crumb';
      const angle = (Math.PI * 2 * i) / count + (Math.random() - 0.5) * 0.5;
      const dist = 50 + Math.random() * 90;
      const dx = Math.cos(angle) * dist;
      const dy = Math.sin(angle) * dist * 0.75 + 24 + Math.random() * 36;
      const rot = `${(Math.random() * 260 - 130).toFixed(0)}deg`;
      const size = 4 + Math.random() * 6;
      crumb.style.setProperty('--dx', `${dx.toFixed(1)}px`);
      crumb.style.setProperty('--dy', `${dy.toFixed(1)}px`);
      crumb.style.setProperty('--rot', rot);
      crumb.style.width = `${size}px`;
      crumb.style.height = `${size * 0.85}px`;
      crumb.style.animationDelay = `${0.32 + Math.random() * 0.22}s`;
      crumb.style.background = i % 3 === 0 ? '#e2c994' : i % 2 === 0 ? '#d4bc8e' : '#a88955';
      layer.appendChild(crumb);
    }
  }

  function clearCrumbs() {
    const layer = $('crumb-layer');
    if (layer) layer.innerHTML = '';
  }

  /**
   * Crack first (cookie stays fixed size, slip stays hidden),
   * then reveal slip between halves, then expand layout.
   */
  function playCrackAndShow(fortuneText, { canRetry = false, orderId = null } = {}) {
    clearCrackTimers();
    clearPaymentParams();

    const refusal = canRetry || isRefusalText(fortuneText);
    const [b1, b2, b3] = refusal
      ? [fortuneText.replace(/\[БЛОК\s*\d+[^\]]*\]/gi, '').trim(), '', '']
      : parseFortuneBlocks(fortuneText);

    $('fortune-block-1').textContent = b1;
    $('fortune-block-2').textContent = b2;
    $('fortune-block-3').textContent = b3;

    // Keep cookie theater visible; hide pay form / loader
    stageForm.classList.add('hidden');
    stageLoader.classList.add('hidden');
    stageLoader.classList.remove('flex');
    stageAgain.classList.add('hidden');
    stageRetry.classList.add('hidden');

    resetSlipHidden();
    cookieWrap.classList.remove('is-revealed');
    cookieStage.classList.remove('is-fortune');

    spawnCrumbs();
    cookieWrap.classList.add('is-cracking', 'is-impact');

    // 1) Let halves split (~1.2s)
    later(1180, () => {
      // 2) Reveal slip still absolutely centered between halves
      fortuneSlip.classList.remove('opacity-0');
      fortuneSlip.classList.add('is-visible', 'is-centered-reveal');
    });

    // 3) Settle into document flow + actions
    later(1750, () => {
      cookieWrap.classList.add('is-revealed');
      cookieStage.classList.add('is-fortune');
      fortuneSlip.classList.remove(
        'absolute',
        'left-1/2',
        'top-1/2',
        '-translate-x-1/2',
        '-translate-y-1/2',
        'is-centered-reveal'
      );
      fortuneSlip.classList.add('relative', 'w-full');
      cookieWrap.classList.remove('is-impact');

      if (refusal && orderId) {
        retryOrderId = orderId;
        sessionStorage.setItem('raskusi_retryOrderId', orderId);
        inputRetryQuestion.value = '';
        clearRetryError();
        stageRetry.classList.remove('hidden');
      } else {
        retryOrderId = null;
        sessionStorage.removeItem('raskusi_retryOrderId');
        stageAgain.classList.remove('hidden');
      }
    });
  }

  function stopPolling() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
  }

  async function fetchFortune(orderId) {
    const res = await fetch(`/api/get-fortune?orderId=${encodeURIComponent(orderId)}`, {
      headers: { Accept: 'application/json' },
    });
    const data = await res.json().catch(() => ({}));
    return { res, data };
  }

  function pollUntilPaid(orderId, generation, { maxAttempts = 40, intervalMs = 1500 } = {}) {
    if (!loaderText.textContent || /транзакц/i.test(loaderText.textContent)) {
      loaderText.textContent = 'Проверяем транзакцию...';
    }
    setStage('loader');

    let attempts = 0;
    let inFlight = false;

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (fn, value) => {
        if (settled) return;
        settled = true;
        stopPolling();
        fn(value);
      };

      const tick = async () => {
        if (settled || generation !== flowGeneration || inFlight) return;
        attempts += 1;
        inFlight = true;

        try {
          const { res, data } = await fetchFortune(orderId);

          if (settled || generation !== flowGeneration) return;

          if (res.ok && data.success && data.fortune) {
            finish(resolve, data);
            return;
          }

          if (res.status === 403) {
            loaderText.textContent = 'Проверяем транзакцию...';
          } else if (res.ok || res.status === 202) {
            loaderText.textContent = 'Готовим предсказание...';
          }

          if (res.status === 404) {
            finish(reject, new Error(data.error || 'Заказ не найден или уже использован.'));
            return;
          }

          if (res.status !== 403 && !res.ok) {
            finish(reject, new Error(data.error || 'Ошибка при получении предсказания.'));
            return;
          }

          if (attempts >= maxAttempts) {
            finish(
              reject,
              new Error(
                'Оплата не подтверждена вовремя. Если средства списались, напишите в поддержку.'
              )
            );
          }
        } catch {
          if (settled || generation !== flowGeneration) return;
          if (attempts >= maxAttempts) {
            finish(reject, new Error('Сеть недоступна. Проверьте соединение и попробуйте снова.'));
          }
        } finally {
          inFlight = false;
        }
      };

      tick();
      pollTimer = setInterval(tick, intervalMs);
    });
  }

  async function startPayment() {
    clearError();
    const generation = ++flowGeneration;
    btnPay.disabled = true;
    loaderText.textContent = 'Создаём платёж...';
    setStage('loader');

    const payload = {
      name: inputName.value.trim(),
      gender: selectedGender,
      question: inputQuestion.value.trim(),
    };

    try {
      const res = await fetch('/api/create-payment', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json().catch(() => ({}));

      if (generation !== flowGeneration) return;

      if (!res.ok || !data.success || !data.PaymentURL) {
        throw new Error(data.error || 'Не удалось создать платёж.');
      }

      activeOrderId = data.orderId;
      sessionStorage.setItem('raskusi_orderId', data.orderId);

      loaderText.textContent = 'Проверяем транзакцию...';
      window.location.href = data.PaymentURL;
    } catch (err) {
      if (generation !== flowGeneration) return;
      setStage('form');
      showError(err.message || 'Ошибка сети. Попробуйте позже.');
      btnPay.disabled = false;
    }
  }

  async function resumeAfterPayment(orderId) {
    const generation = ++flowGeneration;
    activeOrderId = orderId;
    sessionStorage.removeItem('raskusi_orderId');
    loaderText.textContent = 'Готовим предсказание...';

    try {
      const data = await pollUntilPaid(orderId, generation);
      if (generation !== flowGeneration) return;
      playCrackAndShow(data.fortune, {
        canRetry: Boolean(data.canRetry),
        orderId: data.orderId || orderId,
      });
    } catch (err) {
      if (generation !== flowGeneration) return;
      clearPaymentParams();
      setStage('form');
      btnPay.disabled = false;
      const msg = err?.message || '';
      if (/не найден|уже использован/i.test(msg)) {
        clearError();
        return;
      }
      showError(msg || 'Не удалось получить предсказание.');
    }
  }

  async function retryFortune() {
    clearRetryError();
    const orderId = retryOrderId || sessionStorage.getItem('raskusi_retryOrderId');
    if (!orderId) {
      showRetryError('Сессия повтора истекла. Оформите новое предсказание.');
      return;
    }

    const question = inputRetryQuestion.value.trim();
    if (!question) {
      showRetryError('Введите новый вопрос.');
      return;
    }

    const generation = ++flowGeneration;
    btnRetry.disabled = true;
    loaderText.textContent = 'Готовим предсказание...';
    setStage('loader');

    try {
      const res = await fetch('/api/retry-fortune', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({
          orderId,
          name: inputName.value.trim(),
          gender: selectedGender,
          question,
        }),
      });
      const data = await res.json().catch(() => ({}));

      if (generation !== flowGeneration) return;

      if (!res.ok || !data.success || !data.fortune) {
        throw new Error(data.error || 'Не удалось получить предсказание.');
      }

      // Reset cookie visuals for a fresh crack
      cookieWrap.classList.remove('is-cracking', 'is-revealed', 'is-impact');
      clearCrumbs();
      resetSlipHidden();

      playCrackAndShow(data.fortune, {
        canRetry: Boolean(data.canRetry),
        orderId: data.orderId || orderId,
      });
    } catch (err) {
      if (generation !== flowGeneration) return;
      stageRetry.classList.remove('hidden');
      stageLoader.classList.add('hidden');
      stageLoader.classList.remove('flex');
      showRetryError(err.message || 'Ошибка сети. Попробуйте снова.');
    } finally {
      btnRetry.disabled = false;
    }
  }

  function resetToForm() {
    flowGeneration += 1;
    stopPolling();
    clearCrackTimers();
    activeOrderId = null;
    retryOrderId = null;
    selectedGender = '';
    document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('is-active'));
    inputName.value = '';
    inputQuestion.value = '';
    inputRetryQuestion.value = '';
    sessionStorage.removeItem('raskusi_orderId');
    sessionStorage.removeItem('raskusi_retryOrderId');
    clearError();
    clearRetryError();
    btnPay.disabled = false;
    clearPaymentParams();
    setStage('form');
  }

  btnPay.addEventListener('click', (event) => {
    event.preventDefault();
    if (btnPay.disabled) return;
    startPayment();
  });

  btnAgain.addEventListener('click', (event) => {
    event.preventDefault();
    resetToForm();
  });

  btnRetry.addEventListener('click', (event) => {
    event.preventDefault();
    if (btnRetry.disabled) return;
    retryFortune();
  });

  async function init() {
    try {
      const health = await fetch('/api/health').then((r) => r.json());
      if (health.demoMode) {
        demoHint.classList.remove('hidden');
      }
    } catch {
      /* ignore */
    }

    const params = new URLSearchParams(window.location.search);
    const orderId = params.get('orderId');
    const status = params.get('status');
    const stored = sessionStorage.getItem('raskusi_orderId');

    if (status === 'fail') {
      sessionStorage.removeItem('raskusi_orderId');
      showError('Оплата не завершена. Вы можете попробовать снова.');
      clearPaymentParams();
      return;
    }

    if (orderId && (status === 'success' || !status)) {
      await resumeAfterPayment(orderId);
      return;
    }

    if (stored) {
      await resumeAfterPayment(stored);
    }
  }

  init();
})();
