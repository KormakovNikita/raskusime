(() => {
  const $ = (id) => document.getElementById(id);

  const stageForm = $('stage-form');
  const stageLoader = $('stage-loader');
  const stageAgain = $('stage-again');
  const loaderText = $('loader-text');
  const formError = $('form-error');
  const demoHint = $('demo-hint');
  const cookieStage = $('cookie-stage');
  const cookieWrap = $('cookie-wrap');
  const fortuneSlip = $('fortune-slip');
  const btnPay = $('btn-pay');
  const btnAgain = $('btn-again');
  const inputName = $('input-name');
  const inputQuestion = $('input-question');

  let selectedGender = '';
  let pollTimer = null;
  let activeOrderId = null;
  /** Bumped to ignore stale async payment/poll results after reset or a newer flow. */
  let flowGeneration = 0;

  document.querySelectorAll('.gender-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      selectedGender = btn.dataset.gender || '';
      document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('is-active'));
      btn.classList.add('is-active');
    });
  });

  function showError(message) {
    formError.textContent = message;
    formError.classList.remove('hidden');
  }

  function clearError() {
    formError.textContent = '';
    formError.classList.add('hidden');
  }

  function clearPaymentParams() {
    history.replaceState({}, '', '/');
  }

  function setStage(stage) {
    stageForm.classList.toggle('hidden', stage !== 'form');
    stageLoader.classList.toggle('hidden', stage !== 'loader');
    stageLoader.classList.toggle('flex', stage === 'loader');
    stageAgain.classList.toggle('hidden', stage !== 'fortune');

    if (stage === 'form') {
      cookieWrap.classList.remove('is-cracking');
      cookieStage.classList.remove('is-fortune');
      fortuneSlip.classList.remove('is-visible', 'relative', 'w-full');
      fortuneSlip.classList.add(
        'absolute',
        'left-1/2',
        'top-1/2',
        '-translate-x-1/2',
        '-translate-y-1/2',
        'opacity-0',
        'pointer-events-none'
      );
      ['fortune-block-1', 'fortune-block-2', 'fortune-block-3'].forEach((id) => {
        $(id).textContent = '';
      });
    }

    if (stage === 'fortune') {
      cookieStage.classList.add('is-fortune');
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

  function playCrackAndShow(fortuneText) {
    const [b1, b2, b3] = parseFortuneBlocks(fortuneText);
    $('fortune-block-1').textContent = b1;
    $('fortune-block-2').textContent = b2;
    $('fortune-block-3').textContent = b3;

    clearPaymentParams();
    setStage('fortune');
    cookieWrap.classList.add('is-cracking');

    // Leave absolute centering for the closed cookie; switch slip into document flow
    fortuneSlip.classList.remove(
      'absolute',
      'left-1/2',
      'top-1/2',
      '-translate-x-1/2',
      '-translate-y-1/2',
      'opacity-0',
      'pointer-events-none'
    );
    fortuneSlip.classList.add('relative', 'w-full');

    window.setTimeout(() => {
      fortuneSlip.classList.add('is-visible');
    }, 450);
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
    loaderText.textContent = 'Проверяем транзакцию...';
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
            finish(resolve, data.fortune);
            return;
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

    try {
      const fortune = await pollUntilPaid(orderId, generation);
      if (generation !== flowGeneration) return;
      playCrackAndShow(fortune);
    } catch (err) {
      if (generation !== flowGeneration) return;
      // Spent/unknown order in URL — quietly return to a clean form
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

  function resetToForm() {
    flowGeneration += 1;
    stopPolling();
    activeOrderId = null;
    selectedGender = '';
    document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('is-active'));
    inputName.value = '';
    inputQuestion.value = '';
    sessionStorage.removeItem('raskusi_orderId');
    clearError();
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
