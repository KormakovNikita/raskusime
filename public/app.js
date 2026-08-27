(() => {
  const $ = (id) => document.getElementById(id);

  const stageForm = $('stage-form');
  const stageLoader = $('stage-loader');
  const stageAgain = $('stage-again');
  const loaderText = $('loader-text');
  const formError = $('form-error');
  const demoHint = $('demo-hint');
  const cookieWrap = $('cookie-wrap');
  const fortuneSlip = $('fortune-slip');
  const btnPay = $('btn-pay');
  const btnAgain = $('btn-again');
  const inputName = $('input-name');
  const inputQuestion = $('input-question');

  let selectedGender = '';
  let pollTimer = null;
  let activeOrderId = null;

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

  function setStage(stage) {
    stageForm.classList.toggle('hidden', stage !== 'form');
    stageLoader.classList.toggle('hidden', stage !== 'loader');
    stageLoader.classList.toggle('flex', stage === 'loader');
    stageAgain.classList.toggle('hidden', stage !== 'fortune');

    if (stage === 'form') {
      cookieWrap.classList.remove('is-cracking');
      fortuneSlip.classList.remove('is-visible');
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

  function playCrackAndShow(fortuneText) {
    const [b1, b2, b3] = parseFortuneBlocks(fortuneText);
    $('fortune-block-1').textContent = b1;
    $('fortune-block-2').textContent = b2;
    $('fortune-block-3').textContent = b3;

    setStage('fortune');
    cookieWrap.classList.add('is-cracking');

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

  async function pollUntilPaid(orderId, { maxAttempts = 40, intervalMs = 1500 } = {}) {
    loaderText.textContent = 'Проверяем транзакцию...';
    setStage('loader');

    let attempts = 0;

    return new Promise((resolve, reject) => {
      const tick = async () => {
        attempts += 1;
        try {
          const { res, data } = await fetchFortune(orderId);

          if (res.ok && data.success && data.fortune) {
            stopPolling();
            resolve(data.fortune);
            return;
          }

          if (res.status === 404) {
            stopPolling();
            reject(new Error(data.error || 'Заказ не найден.'));
            return;
          }

          if (res.status !== 403 && !res.ok) {
            stopPolling();
            reject(new Error(data.error || 'Ошибка при получении предсказания.'));
            return;
          }

          if (attempts >= maxAttempts) {
            stopPolling();
            reject(new Error('Оплата не подтверждена вовремя. Если средства списались, напишите в поддержку.'));
            return;
          }
        } catch (err) {
          if (attempts >= maxAttempts) {
            stopPolling();
            reject(new Error('Сеть недоступна. Проверьте соединение и попробуйте снова.'));
            return;
          }
        }
      };

      tick();
      pollTimer = setInterval(tick, intervalMs);
    });
  }

  async function startPayment() {
    clearError();
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

      if (!res.ok || !data.success || !data.PaymentURL) {
        throw new Error(data.error || 'Не удалось создать платёж.');
      }

      activeOrderId = data.orderId;
      sessionStorage.setItem('raskusi_orderId', data.orderId);

      loaderText.textContent = 'Проверяем транзакцию...';
      window.location.href = data.PaymentURL;
    } catch (err) {
      setStage('form');
      showError(err.message || 'Ошибка сети. Попробуйте позже.');
      btnPay.disabled = false;
    }
  }

  async function resumeAfterPayment(orderId) {
    activeOrderId = orderId;
    sessionStorage.removeItem('raskusi_orderId');

    try {
      const fortune = await pollUntilPaid(orderId);
      playCrackAndShow(fortune);
    } catch (err) {
      setStage('form');
      showError(err.message || 'Не удалось получить предсказание.');
      btnPay.disabled = false;
    }
  }

  function resetToForm() {
    stopPolling();
    activeOrderId = null;
    selectedGender = '';
    document.querySelectorAll('.gender-btn').forEach((b) => b.classList.remove('is-active'));
    inputName.value = '';
    inputQuestion.value = '';
    clearError();
    btnPay.disabled = false;
    history.replaceState({}, '', '/');
    setStage('form');
  }

  btnPay.addEventListener('click', startPayment);
  btnAgain.addEventListener('click', resetToForm);

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
      showError('Оплата не завершена. Вы можете попробовать снова.');
      history.replaceState({}, '', '/');
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
