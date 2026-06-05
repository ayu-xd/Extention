const SUPABASE_URL = "https://pkzkoixryggxktaybwkp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBremtvaXhyeWdneGt0YXlid2twIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MDQ2MDQsImV4cCI6MjA5MjE4MDYwNH0.G21RTb9scU7biERl1HqKQYOCUYV4pKStKF9Ls4lo8rY";

let state = {
  accessToken: null,
  refreshToken: null,
  browserId: null,
  browserLabel: null,
  stats: { completed: 0, failed: 0 },
  isProcessing: false,
  processingLockAcquiredAt: 0,
  mainTabId: null,
  additionalTabId: null
};

async function persistDebugLog(msg) {
  try {
    const stored = await chrome.storage.local.get('engineLogs');
    const entry = `<div>[${new Date().toLocaleTimeString()}] ${escapeHtml(String(msg))}</div>`;
    const logHtml = (stored.engineLogs || '') + entry;
    const entries = logHtml.match(/<div>/g) || [];
    let updated = logHtml;

    if (entries.length > 500) {
      const parts = logHtml.split(/(?=<div>)/).filter(Boolean);
      updated = parts.slice(-500).join('');
    }

    await chrome.storage.local.set({ engineLogs: updated });
  } catch (e) {
    console.warn('Failed to persist debug log:', e);
  }
}

function escapeHtml(value) {
  return value.replace(/[&<>"']/g, char => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
  })[char]);
}

function debugLog(msg) {
  persistDebugLog(msg);
  chrome.runtime.sendMessage({ type: "DEBUG_LOG", msg }).catch(()=>null);
}

async function syncStatsFromDatabase() {
  if (!state.browserId) return state.stats;

  try {
    const rows = await supabaseReq(`dm_tasks?select=id,status&browser_instance_id=eq.${state.browserId}&status=in.(completed,failed)`);
    const stats = (rows || []).reduce((acc, row) => {
      if (row.status === 'completed') acc.completed += 1;
      if (row.status === 'failed') acc.failed += 1;
      return acc;
    }, { completed: 0, failed: 0 });

    state.stats = stats;
    await chrome.storage.local.set({ stats });
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats }).catch(()=>null);
    return stats;
  } catch (err) {
    debugLog(`Stats sync error: ${err.message}`);
    return state.stats;
  }
}

// ---------------------------------------------------------------------------
// Supabase REST Client
// ---------------------------------------------------------------------------
async function supabaseReq(path, method = "GET", body = null, _retried = false) {
  const headers = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": `Bearer ${state.accessToken ? state.accessToken : SUPABASE_ANON_KEY}`,
    "Content-Type": "application/json",
    "Prefer": "return=representation"
  };
  const options = { method, headers };
  if (body) options.body = JSON.stringify(body);

  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, options);
  if (res.status === 401 && !_retried && state.refreshToken) {
    debugLog("Token expired, refreshing...");
    const refreshed = await refreshAccessToken();
    if (refreshed) return supabaseReq(path, method, body, true);
  }
  if (!res.ok) {
    throw new Error(`Supabase error: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

async function refreshAccessToken() {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=refresh_token`, {
      method: "POST",
      headers: { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" },
      body: JSON.stringify({ refresh_token: state.refreshToken })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error_description || "Refresh failed");
    state.accessToken = data.access_token;
    state.refreshToken = data.refresh_token;
    await chrome.storage.local.set({ accessToken: state.accessToken, refreshToken: state.refreshToken });
    debugLog("Token refreshed!");
    return true;
  } catch (err) {
    debugLog(`Refresh failed: ${err.message}`);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Extension Core Logic
// ---------------------------------------------------------------------------

async function init() {
  const data = await chrome.storage.local.get(['accessToken', 'refreshToken', 'browserId', 'browserLabel', 'stats', 'mainTabId', 'additionalTabId']);
  if (data.accessToken) state.accessToken = data.accessToken;
  if (data.refreshToken) state.refreshToken = data.refreshToken;
  if (data.browserId) state.browserId = data.browserId;
  if (data.browserLabel) state.browserLabel = data.browserLabel;
  if (data.stats) state.stats = data.stats;
  if (data.mainTabId) state.mainTabId = data.mainTabId;
  if (data.additionalTabId) state.additionalTabId = data.additionalTabId;

  if (state.refreshToken && state.browserId) {
    await refreshAccessToken();
    startEngine();
    await syncStatsFromDatabase();
  } else if (state.accessToken && state.browserId) {
    startEngine();
    await syncStatsFromDatabase();
  }
}

async function handleLogin(email, password) {
  try {
    const res = await fetch(`${SUPABASE_URL}/auth/v1/token?grant_type=password`, {
      method: "POST",
      headers: {
        "apikey": SUPABASE_ANON_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify({ email, password })
    });
    const data = await res.json();
    
    if (!res.ok) throw new Error(data.error_description || data.msg || "Authentication failed");
    
    state.accessToken = data.access_token;
    state.refreshToken = data.refresh_token;
    await chrome.storage.local.set({ accessToken: state.accessToken, refreshToken: state.refreshToken });

    chrome.runtime.sendMessage({ type: "HUB_LOGIN_SUCCESS" }).catch(()=>null);
  } catch(err) {
    chrome.runtime.sendMessage({ type: "HUB_LOGIN_ERROR", error: err.message }).catch(()=>null);
  }
}

function getUserIdFromToken(token) {
  try {
    const base64Url = token.split('.')[1];
    const base64 = base64Url.replace(/-/g, '+').replace(/_/g, '/');
    const jsonPayload = decodeURIComponent(atob(base64).split('').map(function(c) {
        return '%' + ('00' + c.charCodeAt(0).toString(16)).slice(-2);
    }).join(''));
    return JSON.parse(jsonPayload).sub;
  } catch (e) {
    return null;
  }
}

async function fetchBrowsers() {
  try {
    const userId = getUserIdFromToken(state.accessToken);
    const filter = userId ? `user_id=eq.${userId}&` : '';
    const browsers = await supabaseReq(`browser_instances?${filter}select=id,label,instance_key&order=created_at.desc`);
    chrome.runtime.sendMessage({ type: "FETCH_BROWSERS_SUCCESS", browsers }).catch(()=>null);
  } catch (err) {
    debugLog(`Fetch browsers error: ${err.message}`);
  }
}

async function handleConnect(browserId, browserLabel) {
  if (browserId.startsWith("MANUAL_KEY:")) {
    const manualKey = browserId.split(":")[1];
    debugLog(`Resolving manual key ${manualKey}...`);
    try {
      const res = await supabaseReq(`browser_instances?instance_key=eq.${manualKey}&select=id`);
      if (res && res.length > 0) {
        browserId = res[0].id;
        debugLog(`Resolved manually!`);
      } else {
        throw new Error("Pairing key not found in DB");
      }
    } catch (err) {
      debugLog(`Resolve Error: ${err.message}`);
      chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: err.message }).catch(()=>null);
      return;
    }
  }

  state.browserId = browserId;
  state.browserLabel = browserLabel;
  state.stats = { completed: 0, failed: 0 };
  
  await chrome.storage.local.set({ 
    browserId: state.browserId, 
    browserLabel: state.browserLabel,
    stats: state.stats 
  });

  await syncStatsFromDatabase();

  startEngine();
  chrome.runtime.sendMessage({ type: "HUB_CONNECTED_SUCCESS", label: state.browserLabel, stats: state.stats }).catch(()=>null);
}

function startEngine() {
  stopEngine();
  console.log(`Starting Engine with Browser ID: ${state.browserId}`);
  debugLog(`Engine started for ${state.browserLabel}`);
  
  // Create alarms for Manifest V3 background script
  chrome.alarms.create("engine_heartbeat", { periodInMinutes: 1 });
  chrome.alarms.create("engine_poll", { periodInMinutes: 0.25 }); // 15 seconds
  chrome.alarms.create("engine_refresh_token", { periodInMinutes: 45 }); // Refresh JWT every 45 min

  // Trigger initial runs
  sendHeartbeat();
  pollTasks();
}

function stopEngine() {
  chrome.alarms.clear("engine_heartbeat");
  chrome.alarms.clear("engine_poll");
  chrome.alarms.clear("engine_refresh_token");
  state.isProcessing = false;
  console.log("Engine stopped.");
}

// Listen to alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "engine_heartbeat") {
    sendHeartbeat();
  } else if (alarm.name === "engine_poll") {
    pollTasks();
  } else if (alarm.name === "engine_refresh_token") {
    refreshAccessToken();
  }
});

async function sendHeartbeat() {
  if (!state.browserId) return;
  try {
    await supabaseReq(`browser_instances?id=eq.${state.browserId}`, "PATCH", {
      last_heartbeat_at: new Date().toISOString(),
      status: 'active'
    });
    debugLog(`Heartbeat sent! Status: active`);
  } catch (err) {
    console.error("Heartbeat failed:", err);
    debugLog(`Heartbeat Error: ${err.message}`);
  }
}

// ---------------------------------------------------------------------------
// Pacing Engine Helpers
// ---------------------------------------------------------------------------

async function checkDailyLimit() {
  const data = await chrome.storage.local.get(['pacingSettings', 'dailyStats']);
  const settings = data.pacingSettings || { dailyLimit: 30, baseDelay: 90, minVariance: 5, maxVariance: 300 };
  
  let stats = data.dailyStats || { date: new Date().toDateString(), sent: 0 };
  
  if (stats.date !== new Date().toDateString()) {
    // Reset for new day
    stats = { date: new Date().toDateString(), sent: 0 };
    await chrome.storage.local.set({ dailyStats: stats });
  }
  
  return {
    isLimited: stats.sent >= settings.dailyLimit,
    sent: stats.sent,
    limit: settings.dailyLimit,
    settings: settings
  };
}

async function incrementDailyLimit() {
  const data = await chrome.storage.local.get(['dailyStats']);
  let stats = data.dailyStats || { date: new Date().toDateString(), sent: 0 };
  stats.sent += 1;
  await chrome.storage.local.set({ dailyStats: stats });
}

function randomInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function pollTasks() {
  if (!state.browserId) return;
  const pacingData = await chrome.storage.local.get('wakeUpAt');
  if (pacingData.wakeUpAt && Date.now() < pacingData.wakeUpAt) {
    return; // Still sleeping for human pacing
  }

  if (state.isProcessing) {
    // Safety auto-unlock if stuck for more than 10 minutes (600,000 ms)
    if (Date.now() - state.processingLockAcquiredAt > 600000) {
      debugLog(`[System] Auto-recovering locked engine.`);
      state.isProcessing = false;
    } else {
      // Normal pacing block — silently return to avoid log spam
      return;
    }
  }

  // Check if engine is paused by user
  const pauseData = await chrome.storage.local.get('enginePaused');
  if (pauseData.enginePaused) {
    return; // Silently skip polling when paused
  }
  
  try {
    const limitCheck = await checkDailyLimit();
    if (limitCheck.isLimited) {
      debugLog(`[Pacing] Daily limit reached (${limitCheck.sent}/${limitCheck.limit}). Pausing tasks until tomorrow.`);
      return;
    }

    const url = `dm_tasks?select=*&browser_instance_id=eq.${state.browserId}&status=eq.pending&order=created_at.asc&limit=1`;
    // 1. Fetch pending task
    const tasks = await supabaseReq(url);

    if (!tasks || tasks.length === 0) {
      // Diagnostic check: what CAN we see?
      const allTasks = await supabaseReq(`dm_tasks?select=id,status,browser_instance_id,task_type`);
      debugLog(`[Poll] 0 pending tasks found for ${state.browserId}. Diagnostic: visible tasks total = ${allTasks ? allTasks.length : 0}`);
      
      if (allTasks && allTasks.length > 0) {
         debugLog(`[Poll] First visible task: status=${allTasks[0].status}, browserId=${allTasks[0].browser_instance_id}`);
      }
      return; // Not processing, will retry on next alarm naturally
    }
    
    const task = tasks[0];
    state.isProcessing = true;
    state.processingLockAcquiredAt = Date.now();
    
    // Fetch contact separately if it's a DM task
    if (task.contact_id) {
      const contacts = await supabaseReq(`contacts?select=username&id=eq.${task.contact_id}`);
      if (contacts && contacts.length > 0) {
        task.contacts = contacts[0];
      }
    }

    // 2. Claim task (Processing)
    await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
      status: "processing"
    });

    console.log("Processing task:", task);
    debugLog(`Processing task: ${task.task_type}`);

    // 3. Execute
    let result;
    try {
      result = await executeTask(task);
      
      // 4a. Success
      await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
        status: "completed",
        completed_at: new Date().toISOString()
      });
      
      // Update contact pipeline status
      if (task.contact_id && task.task_type === 'first_dm') {
        await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
          status: "dmed",
          dmed_at: new Date().toISOString()
        });
      }
      
      state.stats.completed++;
      debugLog(`Task Completed: ${task.task_type}`);
    } catch (err) {
      // 4b. Failed
      console.error("Task failed:", err);
      await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
        status: "failed",
        error_reason: err.message || String(err)
      });
      state.stats.failed++;
      debugLog(`Task Failed: ${err.message}`);
    }

    // Save stats & UI update
    await chrome.storage.local.set({ stats: state.stats });
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats: state.stats }).catch(()=>null);

    // Only increment daily limit if it was actually a DM
    if (task.task_type === 'first_dm' || task.task_type === 'followup_1a') {
      await incrementDailyLimit();
    }

    // PACING INJECTION: Hold lock for randomized delay
    const extra = randomInt(limitCheck.settings.minVariance, limitCheck.settings.maxVariance);
    const delayMs = Math.max(0, limitCheck.settings.baseDelay + extra) * 1000;
    
    debugLog(`[Pacing] Sleeping for ${Math.round(delayMs/1000)}s to mimic human break...`);

    const wakeUpAt = Date.now() + delayMs;
    await chrome.storage.local.set({ wakeUpAt });
    
    state.isProcessing = false;

  } catch (err) {
    console.error("Polling error:", err);
    state.isProcessing = false; // Drop lock on hard crash
  }
}

// ---------------------------------------------------------------------------
// Instagram Tab & Content Script Communication
// ---------------------------------------------------------------------------

async function executeTask(task) {
  if (task.task_type === 'first_dm' || task.task_type === 'followup_1a') {
    const targetUsername = task.contacts?.username;
    if (!targetUsername) throw new Error("Missing target username in contact relation");

    const nameSettings = await chrome.storage.local.get('usePreresolvedNames');
    const usePreresolved = nameSettings.usePreresolvedNames !== false; // default ON

    const payload = {
      target: { username: targetUsername },
      message: { text: task.message_text },
      taskId: task.id,
      usePreresolvedNames: usePreresolved
    };
    
    const res = await sendTaskToContent("main", "sendMessage", payload);
    if (!res?.success) throw new Error(res?.error?.error || "Send message failed");
    return true;
  } 
  else if (task.task_type === 'scrape_followers' || task.task_type === 'scrape_following') {
    return new Promise(async (resolve, reject) => {
      let resolved = false;

      const handler = async (message) => {
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            
            try {
              const targets = payload.data.targets;
              if (targets && targets.length > 0) {
                // 1. Create Target List
                const params = JSON.parse(task.message_text);
                const typeStr = task.task_type === 'scrape_followers' ? "followers" : "following";
                
                const listRes = await supabaseReq(`target_lists`, "POST", {
                  user_id: task.user_id,
                  name: `Scraped: ${params.target} (${typeStr})`,
                  type: "raw",
                  count: targets.length
                });

                if (listRes && listRes.length > 0) {
                  const listId = listRes[0].id;
                  
                  // 2. Insert Contacts (batch of 1000 max to avoid payload limits)
                  let contactIds = [];
                  for (let i = 0; i < targets.length; i += 1000) {
                    const chunk = targets.slice(i, i + 1000);
                    const contactsToInsert = chunk.map(t => ({
                      user_id: task.user_id,
                      username: t.username,
                      full_name: t.fullName || t.username,
                      profile_link: `https://instagram.com/${t.username}`,
                      status: 'not_started'
                    }));
                    
                    const cRes = await supabaseReq(`contacts?select=id`, "POST", contactsToInsert);
                    if (cRes) contactIds = contactIds.concat(cRes.map(c => c.id));
                  }

                  // 3. Link Contacts to Target List
                  for (let i = 0; i < contactIds.length; i += 1000) {
                    const chunk = contactIds.slice(i, i + 1000);
                    const links = chunk.map(cId => ({
                      target_list_id: listId,
                      contact_id: cId
                    }));
                    await supabaseReq(`target_list_items`, "POST", links);
                  }
                }
              }
              resolve(true);
            } catch (err) {
              reject(err);
            }
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            reject(new Error(payload.data.error || "Scraping failed"));
          }
        }
      };
      
      chrome.runtime.onMessage.addListener(handler);

      const params = JSON.parse(task.message_text);
      const res = await sendTaskToContent("additional", "parsing", {
        taskId: task.id,
        username: params.target,
        type: task.task_type === 'scrape_followers' ? "followers" : "following",
        limit: params.limit
      });
      
      if (!res?.success) {
         if (!resolved) {
           resolved = true;
           chrome.runtime.onMessage.removeListener(handler);
           reject(new Error(res?.error?.error || "Failed to start scrape"));
         }
      }
    });
  }
  else {
    throw new Error(`Unsupported task_type: ${task.task_type}`);
  }
}

function randUrl() {
  const urls = [
    "https://www.instagram.com/instagram",
    "https://instagram.com",
    "https://www.instagram.com/direct/inbox/",
    "https://www.instagram.com/explore/"
  ];
  return urls[Math.floor(Math.random() * urls.length)];
}

async function openTab(type) {
  const stateKey = type === 'main' ? 'mainTabId' : 'additionalTabId';
  
  if (state[stateKey]) {
    try {
      const tab = await chrome.tabs.get(state[stateKey]);
      if (tab && !tab.discarded) {
        debugLog(`Reusing existing ${type} tab ${state[stateKey]}`);
        return state[stateKey];
      }
    } catch (e) {
      state[stateKey] = null;
    }
  }

  debugLog(`Opening pinned Instagram ${type} tab...`);

  const tab = await chrome.tabs.create({
    url: randUrl(),
    active: false,
    index: 0,
    pinned: true
  });

  state[stateKey] = tab.id;
  await chrome.storage.local.set({ [stateKey]: tab.id });

  debugLog(`Tab opened (${type}): ${tab.id}, waiting for load...`);

  for (let i = 0; i < 25; i++) {
    try {
      const t = await chrome.tabs.get(tab.id);
      if (t.status === "complete") break;
    } catch(e) { break; }
    await sleep(400);
  }

  debugLog(`Tab ready (${type}).`);
  return tab.id;
}

async function closeTabs() {
  if (state.mainTabId) {
    try { await chrome.tabs.remove(state.mainTabId); } catch(e) {}
    state.mainTabId = null;
    await chrome.storage.local.remove('mainTabId');
    debugLog("Main Tab closed.");
  }
  if (state.additionalTabId) {
    try { await chrome.tabs.remove(state.additionalTabId); } catch(e) {}
    state.additionalTabId = null;
    await chrome.storage.local.remove('additionalTabId');
    debugLog("Additional Tab closed.");
  }
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function sendTaskToContent(tabType, taskType, taskData) {
  const tabId = await openTab(tabType);

  debugLog(`Sending '${taskType}' to tab ${tabId}`);

  // Ping first to confirm content script is alive
  let pingOk = false;
  for (let i = 0; i < 5; i++) {
    try {
      await chrome.tabs.sendMessage(tabId, {
        type: "adblock:info:to-content",
        data: { type: "ping", data: {} }
      });
      pingOk = true;
      break;
    } catch(e) {
      await sleep(2000);
    }
  }

  if (!pingOk) {
    debugLog("Content script not responding, reloading tab...");
    await chrome.tabs.reload(tabId);
    await sleep(8000);
  }

  const response = await chrome.tabs.sendMessage(tabId, {
    type: "adblock:info:to-content",
    data: { type: taskType, data: taskData }
  });

  return response;
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HUB_LOGIN") {
    handleLogin(message.payload.email, message.payload.password);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "FETCH_BROWSERS") {
    fetchBrowsers();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_CONNECT") {
    handleConnect(message.payload.browserId, message.payload.browserLabel);
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_DISCONNECT") {
    stopEngine();
    closeTabs();
    state.browserId = null;
    state.browserLabel = null;
    state.stats = { completed: 0, failed: 0 };
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "GET_STATS") {
    (async () => {
      try {
        const stats = await syncStatsFromDatabase();
        sendResponse({ ok: true, stats });
      } catch (err) {
        sendResponse({ ok: false, error: err.message });
      }
    })();
    return true;
  }
  if (message.type === "HUB_PAUSE_ENGINE") {
    debugLog("[Engine] Paused by user.");
    closeTabs();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_RESUME_ENGINE") {
    debugLog("[Engine] Resumed by user. Opening tab eagerly.");
    openTab('main'); // Eagerly load tab so it's ready for polling
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_SESSION_SYNCED") {
    // Check if we already have the same token to avoid unnecessary restarts
    if (state.accessToken !== message.payload.accessToken) {
      state.accessToken = message.payload.accessToken;
      state.refreshToken = message.payload.refreshToken;
      chrome.storage.local.set({ accessToken: state.accessToken, refreshToken: state.refreshToken }).then(() => {
        chrome.runtime.sendMessage({ type: "HUB_LOGIN_SUCCESS" }).catch(()=>null);
        debugLog("Auto-Login Sync Successful!");
      });
    }
    sendResponse({ ok: true });
    return;
  }

  // --- Content Script Messages (via BackgroundConnector) ---
  if (message.type === "adblock:info:to-background") {
    const taskType = message.data?.type;
    const taskData = message.data?.data;

    // getTabType: critical — tells content.js it's the "main" tab
    if (taskType === "getTabType") {
      const tabId = sender.tab?.id;
      (async () => {
        let result = null;
        if (tabId && state.mainTabId && tabId === state.mainTabId) result = "main";
        if (tabId && state.additionalTabId && tabId === state.additionalTabId) result = "additional";
        sendResponse({ success: true, result });
      })();
      return true; // async response
    }

    // sleep: content script uses this to sleep without blocking
    if (taskType === "sleep") {
      const ms = taskData?.time || 1000;
      (async () => {
        await sleep(ms);
        sendResponse({ success: true, result: true });
      })();
      return true;
    }

    // pong: content script acknowledges ping
    if (taskType === "pong") {
      sendResponse({ success: true });
      return;
    }

    // log: content script sending a log
    if (taskType === "log") {
      const logMsg = `[Content] ${taskData?.type}`;
      debugLog(logMsg);
      sendResponse({ success: true });
      return;
    }

    // successTask / errorTask: scraping results
    if (taskType === "successTask" || taskType === "errorTask") {
      // already handled by the Promise listener in executeTask
      sendResponse({ success: true });
      return;
    }

    // Default passthrough
    sendResponse({ success: true });
    return;
  }
});

chrome.tabs.onRemoved.addListener(tabId => {
  if (state.mainTabId === tabId) state.mainTabId = null;
  if (state.additionalTabId === tabId) state.additionalTabId = null;
});

// Boot
init();
