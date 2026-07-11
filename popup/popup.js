document.addEventListener('DOMContentLoaded', async () => {
  const loginView = document.getElementById('loginView');
  const selectView = document.getElementById('selectView');
  const activeView = document.getElementById('activeView');

  const loginBtn = document.getElementById('loginBtn');
  const connectBtn = document.getElementById('connectBtn');
  const logoutBtn = document.getElementById('logoutBtn');
  const disconnectBtn = document.getElementById('disconnectBtn');

  const emailInput = document.getElementById('email');
  const passwordInput = document.getElementById('password');
  const browserSelect = document.getElementById('browserSelect');
  const manualPairingKey = document.getElementById('manualPairingKey');
  const manualFallbackGroup = document.getElementById('manualFallbackGroup');

  const loginMessage = document.getElementById('loginMessage');
  const selectMessage = document.getElementById('selectMessage');
  const settingsMessage = document.getElementById('settingsMessage');

  const browserLabelDisplay = document.getElementById('browserLabelDisplay');
  const tasksCompletedDisplay = document.getElementById('tasksCompletedDisplay');
  const statusIndicator = document.getElementById('statusIndicator');
  const engineToggleBtn = document.getElementById('engineToggleBtn');
  const engineStateTitle = document.getElementById('engineStateTitle');
  const engineStateCopy = document.getElementById('engineStateCopy');

  const settingsBtn = document.getElementById('settingsBtn');
  const settingsPanel = document.getElementById('settingsPanel');
  const saveSettingsBtn = document.getElementById('saveSettingsBtn');
  const dailyLimitIn = document.getElementById('dailyLimit');
  const baseDelayIn = document.getElementById('baseDelay');
  const minVarianceIn = document.getElementById('minVariance');
  const maxVarianceIn = document.getElementById('maxVariance');
  const preresolvedToggle = document.getElementById('usePreresolvedToggle');

  const imageUploadInput = document.getElementById('imageUploadInput');
  const selectImagesBtn = document.getElementById('selectImagesBtn');
  const clearImagesBtn = document.getElementById('clearImagesBtn');
  const imageCountDisplay = document.getElementById('imageCountDisplay');

  const debugDiv = document.getElementById('debugLogs');
  const downloadLogsBtn = document.getElementById('downloadLogsBtn');
  const clearLogsBtn = document.getElementById('clearLogsBtn');
  const autoScrollToggle = document.getElementById('autoScrollToggle');
  let autoScrollLogs = true;

  const navHomeBtn = document.getElementById('navHomeBtn');
  const navLogsBtn = document.getElementById('navLogsBtn');
  const navSettingsBtn = document.getElementById('navSettingsBtn');
  const moreBtn = document.getElementById('moreBtn');
  const logsBackBtn = document.getElementById('logsBackBtn');
  const settingsBackBtn = document.getElementById('settingsBackBtn');
  const engineScreen = document.getElementById('engineScreen');
  const logsScreen = document.getElementById('logsScreen');
  const settingsScreen = document.getElementById('settingsScreen');

  let state, storedLogs;
  try {
    state = await chrome.storage.local.get(['accessToken', 'browserId', 'browserLabel', 'stats']);
    storedLogs = await chrome.storage.local.get('engineLogs');
  } catch (e) {
    state = { accessToken: null, browserId: null, browserLabel: null, stats: null };
    storedLogs = {};
  }

  if (storedLogs.engineLogs && debugDiv) {
    debugDiv.innerHTML = storedLogs.engineLogs;
    debugDiv.scrollTop = debugDiv.scrollHeight;
  }

  if (state.accessToken && state.browserId) {
    showActiveView(state.browserLabel, state.stats);
  } else if (state.accessToken) {
    showSelectView();
    fetchBrowsers();
  } else {
    showLoginView();
  }

  loginBtn.addEventListener('click', async () => {
    const email = emailInput.value.trim();
    const password = passwordInput.value.trim();

    if (!email || !password) {
      showMessage(loginMessage, 'Please enter Email and Password', 'error');
      return;
    }

    loginBtn.textContent = 'Authenticating...';
    loginBtn.disabled = true;

    chrome.runtime.sendMessage({
      type: 'HUB_LOGIN',
      payload: { email, password }
    });
  });

  connectBtn.addEventListener('click', async () => {
    let selectedId = browserSelect.value;
    let selectedLabel = browserSelect.options[browserSelect.selectedIndex]?.text || 'Manual Connection';

    const manualKey = manualPairingKey.value.trim();
    if (manualKey) {
      selectedId = 'MANUAL_KEY:' + manualKey;
      selectedLabel = 'Browser (' + manualKey + ')';
    }

    if (!selectedId) return;

    connectBtn.textContent = 'Connecting...';
    connectBtn.disabled = true;
    showMessage(selectMessage, '', '');

    chrome.runtime.sendMessage({
      type: 'HUB_CONNECT',
      payload: { browserId: selectedId, browserLabel: selectedLabel }
    });
  });

  logoutBtn.addEventListener('click', async () => {
    await chrome.storage.local.clear();
    chrome.runtime.sendMessage({ type: 'HUB_DISCONNECT' });
    showLoginView();
  });

  disconnectBtn.addEventListener('click', async () => {
    await chrome.storage.local.remove(['browserId', 'browserLabel', 'stats']);
    chrome.runtime.sendMessage({ type: 'HUB_DISCONNECT' });
    showSelectView();
    fetchBrowsers();
  });

  settingsBtn.addEventListener('click', async () => {
    settingsPanel.classList.toggle('hidden');
    if (!settingsPanel.classList.contains('hidden')) {
      await hydrateSettings();
    }
  });

  saveSettingsBtn.addEventListener('click', async () => {
    const minV = parseInt(minVarianceIn.value, 10) || 0;
    const maxV = parseInt(maxVarianceIn.value, 10) || 0;

    if (minV > maxV) {
      showMessage(settingsMessage, 'Min Variance cannot be greater than Max Variance', 'error');
      return;
    }

    const newConf = {
      dailyLimit: parseInt(dailyLimitIn.value, 10) || 30,
      baseDelay: parseInt(baseDelayIn.value, 10) || 90,
      minVariance: minV,
      maxVariance: maxV
    };

    await chrome.storage.local.set({ pacingSettings: newConf });
    showMessage(settingsMessage, 'Settings saved successfully', 'success');
    setTimeout(() => showMessage(settingsMessage, '', ''), 3000);
  });

  engineToggleBtn.addEventListener('click', async () => {
    const data = await chrome.storage.local.get('enginePaused');
    const newPaused = !data.enginePaused;

    await chrome.storage.local.set({ enginePaused: newPaused });
    updateEngineToggle(newPaused);

    chrome.runtime.sendMessage({
      type: newPaused ? 'HUB_PAUSE_ENGINE' : 'HUB_RESUME_ENGINE'
    });
  });

  navHomeBtn?.addEventListener('click', () => showActiveSection('engine'));
  navLogsBtn?.addEventListener('click', () => showActiveSection('logs'));
  navSettingsBtn?.addEventListener('click', () => showActiveSection('settings'));
  moreBtn?.addEventListener('click', () => showActiveSection('settings'));
  logsBackBtn?.addEventListener('click', () => showActiveSection('engine'));
  settingsBackBtn?.addEventListener('click', () => showActiveSection('engine'));

  autoScrollToggle?.addEventListener('click', () => {
    autoScrollLogs = !autoScrollLogs;
    autoScrollToggle.classList.toggle('off', !autoScrollLogs);
    autoScrollToggle.setAttribute('aria-pressed', String(autoScrollLogs));
    if (autoScrollLogs && debugDiv) debugDiv.scrollTop = debugDiv.scrollHeight;
  });

  clearLogsBtn?.addEventListener('click', async () => {
    if (!debugDiv) return;
    debugDiv.innerHTML = '<div>[System] Logs cleared.</div>';
    await chrome.storage.local.set({ engineLogs: debugDiv.innerHTML });
    debugDiv.scrollTop = debugDiv.scrollHeight;
  });

  downloadLogsBtn?.addEventListener('click', async () => {
    if (!debugDiv) return;

    const lines = Array.from(debugDiv.querySelectorAll('div')).map(d => d.textContent).join('\n');
    const blob = new Blob([lines], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');

    a.href = url;
    a.download = `dm-engine-logs-${new Date().toISOString().slice(0, 10)}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  });

  if (preresolvedToggle) {
    const saved = await chrome.storage.local.get('usePreresolvedNames');
    preresolvedToggle.checked = saved.usePreresolvedNames !== false;
    preresolvedToggle.addEventListener('change', async () => {
      await chrome.storage.local.set({ usePreresolvedNames: preresolvedToggle.checked });
    });
  }

  // Initial load of image count
  if (globalThis.ImageStorage && imageCountDisplay) {
    globalThis.ImageStorage.getAllImagesCount().then(count => {
      imageCountDisplay.textContent = count;
    }).catch(e => console.error("Error loading image count", e));
  }

  selectImagesBtn?.addEventListener('click', () => {
    imageUploadInput.click();
  });

  imageUploadInput?.addEventListener('change', async (e) => {
    const files = e.target.files;
    if (!files || files.length === 0) return;
    selectImagesBtn.textContent = 'Saving...';
    selectImagesBtn.disabled = true;
    
    // Detect real image MIME type from magic bytes (file header)
    async function detectMimeType(file) {
      const buffer = await file.slice(0, 12).arrayBuffer();
      const bytes = new Uint8Array(buffer);
      // JPEG: FF D8 FF
      if (bytes[0] === 0xFF && bytes[1] === 0xD8 && bytes[2] === 0xFF) return "image/jpeg";
      // PNG: 89 50 4E 47
      if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) return "image/png";
      // GIF: 47 49 46 38
      if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
      // WebP: 52 49 46 46 ... 57 45 42 50
      if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
          bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
      // BMP: 42 4D
      if (bytes[0] === 0x42 && bytes[1] === 0x4D) return "image/bmp";
      // Default to JPEG if unrecognized
      return "image/jpeg";
    }

    try {
      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Strip any file extension (everything after last dot) so the key matches the Instagram username
        const username = file.name.replace(/\.[^.]+$/, "");
        
        // Detect real MIME type (in case file has wrong/missing extension like .sol)
        let mimeType = file.type;
        if (!mimeType || !mimeType.startsWith("image/")) {
          mimeType = await detectMimeType(file);
          console.log(`[ImageManager] Detected MIME type for "${file.name}": ${mimeType} (original: "${file.type}")`);
        }
        
        // Re-wrap as a Blob with the correct MIME type
        const correctBlob = new Blob([await file.arrayBuffer()], { type: mimeType });
        await globalThis.ImageStorage.saveImage(username, correctBlob);
      }
      const newCount = await globalThis.ImageStorage.getAllImagesCount();
      if (imageCountDisplay) imageCountDisplay.textContent = newCount;
    } catch (err) {
      console.error("Upload error", err);
    } finally {
      selectImagesBtn.textContent = 'Select Images';
      selectImagesBtn.disabled = false;
      imageUploadInput.value = '';
    }
  });

  clearImagesBtn?.addEventListener('click', async () => {
    if (confirm("Are you sure you want to clear all loaded images?")) {
      try {
        await globalThis.ImageStorage.clearAll();
        const newCount = await globalThis.ImageStorage.getAllImagesCount();
        if (imageCountDisplay) imageCountDisplay.textContent = newCount;
      } catch (err) {
        console.error("Clear error", err);
      }
    }
  });

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg.type === 'HUB_LOGIN_SUCCESS') {
      showSelectView();
      fetchBrowsers();
    }

    if (msg.type === 'HUB_LOGIN_ERROR') {
      showMessage(loginMessage, msg.error || 'Login failed', 'error');
      loginBtn.textContent = 'Login';
      loginBtn.disabled = false;
    }

    if (msg.type === 'FETCH_BROWSERS_SUCCESS') {
      browserSelect.innerHTML = '';
      showMessage(selectMessage, '', '');

      if (msg.browsers.length === 0) {
        browserSelect.innerHTML = '<option disabled>No browsers found in dashboard</option>';
      } else {
        msg.browsers.forEach(b => {
          const opt = document.createElement('option');
          opt.value = b.id;
          opt.textContent = `${b.label} (${b.instance_key})`;
          browserSelect.appendChild(opt);
        });
      }

      manualFallbackGroup.classList.remove('hidden');
      connectBtn.disabled = false;
    }

    if (msg.type === 'HUB_CONNECTED_SUCCESS') {
      showActiveView(msg.label, msg.stats);
    }

    if (msg.type === 'HUB_CONNECTED_ERROR') {
      showMessage(selectMessage, msg.error || 'Connection failed', 'error');
      connectBtn.textContent = 'Connect to Hub';
      connectBtn.disabled = false;
    }

    if (msg.type === 'STATS_UPDATE' && tasksCompletedDisplay) {
      tasksCompletedDisplay.textContent = msg.stats?.completed || 0;
    }

    if (msg.type === 'DEBUG_LOG' && debugDiv) {
      appendLog(`[${new Date().toLocaleTimeString()}] ${msg.msg}`);
    }
  });

  function fetchBrowsers() {
    chrome.runtime.sendMessage({ type: 'FETCH_BROWSERS' });
  }

  async function hydrateSettings() {
    const saved = await chrome.storage.local.get('pacingSettings');
    const conf = saved.pacingSettings || { dailyLimit: 30, baseDelay: 90, minVariance: 5, maxVariance: 300 };

    dailyLimitIn.value = conf.dailyLimit;
    baseDelayIn.value = conf.baseDelay;
    minVarianceIn.value = conf.minVariance;
    maxVarianceIn.value = conf.maxVariance;
    showMessage(settingsMessage, '', '');
  }

  async function showActiveView(label, stats) {
    loginView.classList.add('hidden');
    selectView.classList.add('hidden');
    activeView.classList.remove('hidden');

    browserLabelDisplay.textContent = label || 'Unknown';
    tasksCompletedDisplay.textContent = stats?.completed || 0;
    showActiveSection('engine');
    refreshStatsFromBackground();

    const data = await chrome.storage.local.get('enginePaused');
    updateEngineToggle(!!data.enginePaused);
  }

  function showSelectView() {
    loginView.classList.add('hidden');
    activeView.classList.add('hidden');
    selectView.classList.remove('hidden');

    connectBtn.textContent = 'Connect to Hub';
    connectBtn.disabled = true;
    browserSelect.innerHTML = '<option value="" disabled selected>Loading...</option>';
    manualPairingKey.value = '';
    manualFallbackGroup.classList.add('hidden');
    showMessage(selectMessage, '', '');
  }

  function showLoginView() {
    selectView.classList.add('hidden');
    activeView.classList.add('hidden');
    loginView.classList.remove('hidden');

    emailInput.value = '';
    passwordInput.value = '';
    loginBtn.textContent = 'Login';
    loginBtn.disabled = false;
    showMessage(loginMessage, '', '');
  }

  function showActiveSection(section) {
    const screens = {
      engine: engineScreen,
      logs: logsScreen,
      settings: settingsScreen
    };

    Object.values(screens).forEach(screen => screen?.classList.remove('active'));
    screens[section]?.classList.add('active');

    navHomeBtn?.classList.toggle('active', section === 'engine');
    navLogsBtn?.classList.toggle('active', section === 'logs');
    navSettingsBtn?.classList.toggle('active', section === 'settings');
    navSettingsBtn?.classList.toggle('settings-active', section === 'settings');

    if (section === 'logs' && autoScrollLogs && debugDiv) {
      debugDiv.scrollTop = debugDiv.scrollHeight;
    }
    if (section === 'settings') {
      hydrateSettings();
    }
  }

  function updateEngineToggle(isPaused) {
    if (isPaused) {
      engineToggleBtn.classList.remove('running');
      engineToggleBtn.classList.add('paused');
      engineToggleBtn.setAttribute('aria-label', 'Start engine');
      engineToggleBtn.setAttribute('title', 'Start engine');
      engineStateTitle.textContent = 'Paused';
      engineStateCopy.textContent = 'Engine is standing by';
      statusIndicator.textContent = 'Paused';
      statusIndicator.className = 'info-value';
    } else {
      engineToggleBtn.classList.remove('paused');
      engineToggleBtn.classList.add('running');
      engineToggleBtn.setAttribute('aria-label', 'Stop engine');
      engineToggleBtn.setAttribute('title', 'Stop engine');
      engineStateTitle.textContent = 'Running';
      engineStateCopy.textContent = 'Engine is active';
      statusIndicator.textContent = 'Online';
      statusIndicator.className = 'info-value connected-dot';
    }
  }

  function appendLog(text) {
    const entry = document.createElement('div');
    entry.textContent = text;
    debugDiv.appendChild(entry);

    const entries = debugDiv.querySelectorAll('div');
    if (entries.length > 500) {
      for (let i = 0; i < entries.length - 500; i++) entries[i].remove();
    }

    if (autoScrollLogs) debugDiv.scrollTop = debugDiv.scrollHeight;
  }

  function refreshStatsFromBackground() {
    chrome.runtime.sendMessage({ type: 'GET_STATS' }, (response) => {
      if (chrome.runtime.lastError || !response?.stats || !tasksCompletedDisplay) return;
      tasksCompletedDisplay.textContent = response.stats.completed || 0;
    });
  }

  function showMessage(element, msg, type) {
    if (!element) return;
    element.textContent = msg;
    element.className = type ? `message ${type}` : 'message';
  }
});
