const SUPABASE_URL = "https://pkzkoixryggxktaybwkp.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBremtvaXhyeWdneGt0YXlid2twIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzY2MDQ2MDQsImV4cCI6MjA5MjE4MDYwNH0.G21RTb9scU7biERl1HqKQYOCUYV4pKStKF9Ls4lo8rY";

importScripts("assets/imageStorage.js");

let state = {
  accessToken: null,
  refreshToken: null,
  browserId: null,
  browserLabel: null,
  stats: { completed: 0, failed: 0 },
  isProcessing: false,
  processingLockAcquiredAt: 0,
  mainTabId: null,
  additionalTabId: null,
  lastTaskCompletedAt: 0
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
  persistDebugLog(msg).catch(()=>{});
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
  const data = await chrome.storage.local.get(['accessToken', 'refreshToken', 'browserId', 'browserLabel', 'stats', 'mainTabId', 'additionalTabId', 'enginePaused']);
  if (data.accessToken) state.accessToken = data.accessToken;
  if (data.refreshToken) state.refreshToken = data.refreshToken;
  if (data.browserId) state.browserId = data.browserId;
  if (data.browserLabel) state.browserLabel = data.browserLabel;
  if (data.stats) state.stats = data.stats;
  if (data.mainTabId) state.mainTabId = data.mainTabId;
  if (data.additionalTabId) state.additionalTabId = data.additionalTabId;

  // Heartbeat runs 24/7 — even when paused — so the web app knows the browser is online
  if (state.browserId) {
    chrome.alarms.create("engine_heartbeat", { periodInMinutes: 1 });
    sendHeartbeat().catch(()=>{});
  }

  if (data.enginePaused) {
    debugLog("[Init] Engine is paused, skipping task engine auto-start.");
    return;
  }

  if (state.refreshToken && state.browserId) {
    const refreshed = await refreshAccessToken();
    if (refreshed) {
      startEngine();
      await syncStatsFromDatabase();
    }
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
    if (!userId) {
      debugLog("Cannot fetch browsers: invalid or missing token");
      chrome.runtime.sendMessage({ type: "FETCH_BROWSERS_SUCCESS", browsers: [] }).catch(()=>null);
      return;
    }
    const browsers = await supabaseReq(`browser_instances?user_id=eq.${userId}&select=id,label,instance_key&order=created_at.desc`);
    chrome.runtime.sendMessage({ type: "FETCH_BROWSERS_SUCCESS", browsers }).catch(()=>null);
  } catch (err) {
    debugLog(`Fetch browsers error: ${err.message}`);
  }
}

async function handleConnect(browserId, browserLabel) {
  if (!browserId) {
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: "No browser ID provided" }).catch(()=>null);
    return;
  }
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

  try {
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
  } catch (err) {
    debugLog(`Connect error: ${err.message}`);
    chrome.runtime.sendMessage({ type: "HUB_CONNECTED_ERROR", error: err.message }).catch(()=>null);
  }
}

async function startEngine() {
  stopEngine();
  console.log(`Starting Engine with Browser ID: ${state.browserId}`);
  debugLog(`Engine started for ${state.browserLabel}`);

  // Reset any tasks stuck in "processing" back to "pending" (crash recovery)
  if (state.browserId) {
    try {
      const stale = await supabaseReq(`dm_tasks?browser_instance_id=eq.${state.browserId}&status=eq.processing`, "PATCH", { status: "pending" });
      if (stale && stale.length > 0) {
        debugLog(`[Recovery] Reset ${stale.length} stuck processing task(s) back to pending`);
      }
    } catch (err) {
      debugLog(`[Recovery] Failed to reset stale tasks: ${err.message}`);
    }
  }

  // Create alarms for Manifest V3 background script (heartbeat is separate — created in init)
  chrome.alarms.create("engine_poll", { periodInMinutes: 0.25 }); // 15 seconds
  chrome.alarms.create("engine_refresh_token", { periodInMinutes: 45 }); // Refresh JWT every 45 min
  chrome.alarms.create("engine_collect_messages", { periodInMinutes: 2 }); // Every 2 min read-receipt check

  // Trigger initial runs
  pollTasks();
}

function stopEngine() {
  // NOTE: engine_heartbeat is NOT cleared here — it runs 24/7 so the web app knows the browser is online
  chrome.alarms.clear("engine_poll");
  chrome.alarms.clear("engine_refresh_token");
  chrome.alarms.clear("engine_collect_messages");
  console.log("Engine stopped.");
}

// Listen to alarms
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "engine_heartbeat") {
    sendHeartbeat().catch(()=>{});
  } else if (alarm.name === "engine_poll") {
    pollTasks().catch(()=>{});
  } else if (alarm.name === "engine_refresh_token") {
    refreshAccessToken().catch(()=>{});
  } else if (alarm.name === "engine_collect_messages") {
    collectMessagesJob().catch(()=>{});
  }
});

async function collectMessagesJob() {
  if (!state.browserId || state.isProcessing) return;
  const pauseData = await chrome.storage.local.get('enginePaused');
  if (pauseData.enginePaused) return;
  if (!state.mainTabId) return;

  if (state.lastTaskCompletedAt && Date.now() - state.lastTaskCompletedAt < 60000) {
    debugLog("[Collector] Skipping — a DM was sent less than 60s ago, waiting for Instagram to settle.");
    return;
  }

  try {
    debugLog("[Collector] Running periodic read-receipt check via React Fiber...");
    await chrome.tabs.sendMessage(state.mainTabId, {
      type: "adblock:info:to-content",
      isEmit: true,
      data: { type: "collectMessages", data: {} }
    }).catch(() => null);
  } catch (err) {
    debugLog(`[Collector] Error triggering collectMessages: ${err.message}`);
  }
}

async function processCollectedMessages(readReceipts) {
  try {
    if (!Array.isArray(readReceipts) || readReceipts.length === 0) return;

    const seenUsernames = new Set();
    const repliedUsernames = new Set();
    let seenCount = 0;
    let replyCount = 0;

    for (const entry of readReceipts) {
      if (!entry || !entry.username) continue;

      if (entry.hasSeen || entry.hasReply) {
        seenUsernames.add(entry.username.toLowerCase());
        if (entry.hasSeen) seenCount++;
        if (entry.hasReply) {
          replyCount++;
          repliedUsernames.add(entry.username.toLowerCase());
        }
      }
    }

    if (seenUsernames.size > 0) {
      const userList = Array.from(seenUsernames);
      debugLog(`[Collector] Found ${userList.length} contact(s) — ${seenCount} seen, ${replyCount} replied.`);

      for (let i = 0; i < userList.length; i += 50) {
        const chunk = userList.slice(i, i + 50);
        const inQuery = chunk.map(u => `"${u}"`).join(",");
        await supabaseReq(
          `contacts?media_seen=eq.false&username=in.(${inQuery})`,
          "PATCH",
          { media_seen: true, media_seen_at: new Date().toISOString() }
        );
      }
    }

    // Leads who replied: proactively cancel their remaining follow-ups so we never
    // DM someone who already responded — the belt-and-suspenders behind the send-time guard.
    if (repliedUsernames.size > 0) {
      const repliedList = Array.from(repliedUsernames);
      for (let i = 0; i < repliedList.length; i += 50) {
        const chunk = repliedList.slice(i, i + 50);
        const inQuery = chunk.map(u => `"${u}"`).join(",");
        const contacts = await supabaseReq(`contacts?select=id&username=in.(${inQuery})`);
        for (const contact of (contacts || [])) {
          await cancelPendingFollowups(contact.id, "lead_replied");
        }
      }
    }
  } catch (err) {
    debugLog(`[Collector] Error processing collected messages: ${err.message}`);
  }
}

// Cancel any still-pending follow-up tasks for a contact (e.g. after they replied).
// Only touches 'pending' rows — an in-flight 'processing' task is left alone.
async function cancelPendingFollowups(contactId, reason) {
  if (!contactId) return 0;
  try {
    const cancelled = await supabaseReq(
      `dm_tasks?contact_id=eq.${contactId}&status=eq.pending&task_type=like.followup_*`,
      "PATCH",
      { status: "failed", error_reason: reason }
    );
    const count = Array.isArray(cancelled) ? cancelled.length : 0;
    if (count > 0) {
      debugLog(`[Collector] Cancelled ${count} pending follow-up(s) for contact ${contactId} (${reason}).`);
    }
    return count;
  } catch (err) {
    debugLog(`[Collector] Error cancelling follow-ups for contact ${contactId}: ${err.message}`);
    return 0;
  }
}

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
    if (Date.now() - state.processingLockAcquiredAt > 600000) {
      debugLog(`[System] Auto-recovering locked engine.`);
      state.isProcessing = false;
    } else {
      return;
    }
  }

  // Acquire lock immediately (before any awaits) to prevent TOCTOU race
  state.isProcessing = true;
  state.processingLockAcquiredAt = Date.now();

  try {
    // Check if engine is paused by user
    const pauseData = await chrome.storage.local.get('enginePaused');
    if (pauseData.enginePaused) {
      debugLog(`[Poll] Engine paused by user, skipping.`);
      return;
    }

    const limitCheck = await checkDailyLimit();
    if (limitCheck.isLimited) {
      debugLog(`[Pacing] Daily limit reached (${limitCheck.sent}/${limitCheck.limit}).`);
      return;
    }

    // 1. Fetch a pending task
    const url = `dm_tasks?select=*,campaigns!inner(status)&browser_instance_id=eq.${state.browserId}&status=eq.pending&campaigns.status=eq.active&order=created_at.asc&limit=1`;
    const tasks = await supabaseReq(url);

    if (!tasks || tasks.length === 0) {
      debugLog(`[Poll] 0 pending tasks found for browser ${state.browserId}.`);
      return;
    }

    const task = tasks[0];
    delete task.campaigns;

    if (task.contact_id) {
      const contacts = await supabaseReq(`contacts?select=username&id=eq.${task.contact_id}`);
      if (contacts && contacts.length > 0) {
        task.contacts = contacts[0];
      }
    }

    await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", { status: "processing" });

    debugLog(`Processing task: ${task.task_type}`);

    let taskSucceeded = false;
    try {
      const result = await executeTask(task);

      if (result?.isLimited) {
        debugLog("[Pacing] Rate limit detected from content script! Pausing engine to prevent ban.");
        await chrome.storage.local.set({ enginePaused: true });
      }

      await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
        status: "completed",
        completed_at: new Date().toISOString()
      });

      if (task.contact_id && task.task_type === 'first_dm') {
        await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
          status: "dmed",
          dmed_at: new Date().toISOString(),
          assigned_browser_id: state.browserId
        });
      } else if (task.contact_id && task.task_type.startsWith('followup_')) {
        const stepLetter = task.task_type.replace('followup_1', '').toUpperCase() || 'A';
        await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
          followup_1a_sent: true,
          current_follow_up: `1${stepLetter}`,
          last_follow_up_at: new Date().toISOString()
        });
      }

      state.stats.completed++;
      state.lastTaskCompletedAt = Date.now();
      taskSucceeded = true;
      debugLog(`Task Completed: ${task.task_type}`);
    } catch (err) {
      console.error("Task failed:", err);
      const isThreadBusy = err.message?.includes("thread is busy");
      if (isThreadBusy) {
        // Re-queue as pending without increasing retry count (thread was busy with hooks)
        await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", { status: "pending" });
        debugLog(`[Recovery] Task ${task.task_type} re-queued as pending (thread was busy)`);
      } else {
        const isPermanentError = [
          "user_is_unreachable",
          "user_not_found",
          "cannot_message_user",
          "account_disabled",
          "rate_limited_error"
        ].includes(err.unreachableType);

        const currentRetries = Number(task.retry_count || 0);

        if (!isPermanentError && currentRetries < 3) {
          const nextRetry = currentRetries + 1;
          debugLog(`[Retry Engine] Transient error on task ${task.id} (${err.message}). Retrying (${nextRetry}/3)...`);
          
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "pending",
            retry_count: nextRetry,
            error_reason: `[Attempt ${nextRetry}/3] ${err.message || String(err)}`
          });

          // Short 30s backoff delay before retrying transient failures
          const wakeUpAt = Date.now() + 30000;
          await chrome.storage.local.set({ wakeUpAt });
        } else {
          // Permanent error OR max retries reached -> mark as failed
          await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
            status: "failed",
            error_reason: currentRetries >= 3 
              ? `Failed after 3 retries. Last error: ${err.message || String(err)}`
              : (err.message || String(err)),
            unreachable_type: err.unreachableType || null
          });
          
          if (err.unreachableType === "rate_limited_error") {
            debugLog("[Pacing] Rate limit error detected! Pausing engine to prevent ban.");
            await chrome.storage.local.set({ enginePaused: true });
          } else if (err.unreachableType && task.contact_id) {
            await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
              status: "unreachable"
            });
          }

          state.stats.failed++;
          debugLog(`Task Permanently Failed: ${err.message} ${err.unreachableType ? `[${err.unreachableType}]` : ''}`);
        }
      }
    }

    await chrome.storage.local.set({ stats: state.stats });
    chrome.runtime.sendMessage({ type: "STATS_UPDATE", stats: state.stats }).catch(()=>null);

    // Only apply pacing delay and daily limit increment on actual success
    if (taskSucceeded && (task.task_type === 'first_dm' || task.task_type.startsWith('followup_'))) {
      await incrementDailyLimit();

      const extra = randomInt(limitCheck.settings.minVariance, limitCheck.settings.maxVariance);
      const delayMs = Math.max(0, limitCheck.settings.baseDelay + extra) * 1000;

      debugLog(`[Pacing] Sleeping for ${Math.round(delayMs/1000)}s...`);

      const wakeUpAt = Date.now() + delayMs;
      await chrome.storage.local.set({ wakeUpAt });
    }

  } catch (err) {
    console.error("Polling error:", err);
  } finally {
    state.isProcessing = false;
  }
}

// ---------------------------------------------------------------------------
// Instagram Tab & Content Script Communication
// ---------------------------------------------------------------------------

async function executeTask(task) {
  if (task.task_type === 'first_dm') {
    const targetUsername = task.contacts?.username;
    if (!targetUsername) throw new Error("Missing target username in contact relation");

    const nameSettings = await chrome.storage.local.get('usePreresolvedNames');
    const usePreresolved = nameSettings.usePreresolvedNames !== false; // default ON

    let hasImage = false;
    let imageUsername = null;
    let imageArrayBuffer = null;
    let imageType = null;
    
    debugLog(`[Image Lookup] Starting image lookup for username: "${targetUsername}"`);
    debugLog(`[Image Lookup] globalThis exists: ${typeof globalThis !== "undefined"} | ImageStorage exists: ${!!globalThis?.ImageStorage}`);
    
    if (typeof globalThis !== "undefined" && globalThis.ImageStorage) {
      try {
        const totalImages = await globalThis.ImageStorage.getAllImagesCount();
        debugLog(`[Image Lookup] Total images in DB: ${totalImages}`);
        
        const img = await globalThis.ImageStorage.getImage(targetUsername);
        debugLog(`[Image Lookup] getImage("${targetUsername}") returned: ${img ? `Blob(size=${img.size}, type="${img.type}")` : "null"}`);
        
        if (img) {
          hasImage = true;
          imageUsername = targetUsername;
          imageType = img.type || "image/jpeg"; // Fallback if MIME type is empty (e.g. file was saved with non-image extension)
          // Convert Blob to ArrayBuffer for passing through the Chrome Messaging bridge
          const arrayBuf = await img.arrayBuffer();
          // Convert ArrayBuffer to Array for JSON serialization just in case structured cloning fails over MV3 boundaries
          imageArrayBuffer = Array.from(new Uint8Array(arrayBuf));
          debugLog(`[Image Manager] Found local image for ${targetUsername} | type=${imageType} | bufferLen=${imageArrayBuffer.length} | sizeKB=${Math.round(imageArrayBuffer.length/1024)}`);
        } else {
          debugLog(`[Image Lookup] No image found for "${targetUsername}" — the image may not have been saved or the username key doesn't match`);
        }
      } catch(imgErr) {
        debugLog(`[Image Lookup] ERROR retrieving image: ${imgErr?.toString()}`);
      }
    } else {
      debugLog(`[Image Lookup] SKIPPED — ImageStorage not available on globalThis`);
    }

    // If we have an image but the message template doesn't include [IMAGE], append it
    let finalMessageText = task.message_text;
    if (hasImage && !finalMessageText.includes('[IMAGE]')) {
      finalMessageText = finalMessageText + '\n[IMAGE]';
      debugLog(`[Image Manager] Message template missing [IMAGE] token — auto-appended`);
    }

    const payload = {
      target: { username: targetUsername },
      message: { text: finalMessageText },
      taskId: task.id,
      usePreresolvedNames: usePreresolved,
      hasImage,
      imageUsername,
      imageType,
      imageArrayBuffer
    };

    debugLog(`[Image Payload] hasImage=${hasImage} | imageType=${imageType} | bufferExists=${!!imageArrayBuffer} | bufferLen=${imageArrayBuffer?.length ?? 0} | msgHasToken=${finalMessageText.includes('[IMAGE]')}`);
    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.mainTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const data = payload.data;
            (async () => {
              try {
                if (data.threadId) {
                  await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
                    thread_id: data.threadId,
                    last_message_id: data.lastMessageId || null,
                    last_message_ts: data.lastMessageTimestamp || new Date().toISOString(),
                    is_limited: !!data.isLimited
                  });
                }
                if (data.response === true && task.contact_id) {
                  debugLog(`[Guard] Lead replied — skipping send for task ${task.id}, cancelling remaining follow-ups.`);
                  await cancelPendingFollowups(task.contact_id, "lead_replied");
                  await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                    media_seen: true,
                    media_seen_at: new Date().toISOString()
                  });
                }
                resolve({ isLimited: !!data.isLimited });
              } catch (err) {
                resolve({ isLimited: !!data.isLimited });
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const errReason = payload.data.error || "DM failed";
            const errType = payload.data.unreachableType || null;

            const errObj = new Error(errReason);
            errObj.unreachableType = errType;
            reject(errObj);
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error("Task timed out waiting for content script response"));
        }
      }, 300000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const res = await sendTaskToContent("main", "sendMessage", payload);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              clearTimeout(timeoutId);
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  }
  else if (task.task_type.startsWith('followup_')) {
    const targetUsername = task.contacts?.username;
    if (!targetUsername) throw new Error("Missing target username in contact relation");

    let targetUrl = null;
    if (task.thread_id) {
      targetUrl = `https://www.instagram.com/direct/t/${task.thread_id}/`;
      debugLog(`[Followup] Using direct thread URL for ${targetUsername}: ${targetUrl}`);
    }

    const payload = {
      target: { username: targetUsername },
      message: { text: task.message_text },
      taskId: task.id,
      usePreresolvedNames: true,
      skipMessageExistsCheck: false
    };

    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.additionalTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const data = payload.data;
            (async () => {
              try {
                if (data.threadId) {
                  await supabaseReq(`dm_tasks?id=eq.${task.id}`, "PATCH", {
                    thread_id: data.threadId,
                    last_message_id: data.lastMessageId || null,
                    last_message_ts: data.lastMessageTimestamp || new Date().toISOString(),
                    is_limited: !!data.isLimited
                  });
                }
                if (data.response === true && task.contact_id) {
                  debugLog(`[Guard] Lead replied — skipping send for task ${task.id}, cancelling remaining follow-ups.`);
                  await cancelPendingFollowups(task.contact_id, "lead_replied");
                  await supabaseReq(`contacts?id=eq.${task.contact_id}`, "PATCH", {
                    media_seen: true,
                    media_seen_at: new Date().toISOString()
                  });
                }
                resolve({ isLimited: !!data.isLimited });
              } catch (err) {
                resolve({ isLimited: !!data.isLimited });
              }
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            const errObj = new Error(payload.data.error || "Followup failed");
            errObj.unreachableType = payload.data.unreachableType || null;
            reject(errObj);
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error("Followup task timed out waiting for content script response"));
        }
      }, 300000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
          const res = await sendTaskToContent("additional", "sendMessageFromDialog", payload, targetUrl);
          if (!res?.success) {
            if (!resolved) {
              resolved = true;
              chrome.runtime.onMessage.removeListener(handler);
              clearTimeout(timeoutId);
              reject(new Error(res?.error?.error || "Send message failed to start"));
            }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
    });
  } 
  else if (task.task_type === 'scrape_followers' || task.task_type === 'scrape_following') {
    return new Promise((resolve, reject) => {
      let resolved = false;

      const handler = (message, sender) => {
        if (sender.tab?.id !== state.additionalTabId) return;
        if (message.type === "adblock:info:to-background" && message.isEmit) {
          const payload = message.data;
          if (payload.type === "successTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);

            (async () => {
              try {
                const targets = payload.data.targets;
                if (targets && targets.length > 0) {
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
            })();
          } else if (payload.type === "errorTask" && payload.data.taskId === task.id) {
            if (resolved) return;
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(new Error(payload.data.error || "Scraping failed"));
          }
        }
      };

      const timeoutId = setTimeout(() => {
        if (!resolved) {
          resolved = true;
          chrome.runtime.onMessage.removeListener(handler);
          reject(new Error("Scrape task timed out waiting for content script response"));
        }
      }, 300000);

      chrome.runtime.onMessage.addListener(handler);

      (async () => {
        try {
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
               clearTimeout(timeoutId);
               reject(new Error(res?.error?.error || "Failed to start scrape"));
             }
          }
        } catch (err) {
          if (!resolved) {
            resolved = true;
            chrome.runtime.onMessage.removeListener(handler);
            clearTimeout(timeoutId);
            reject(err);
          }
        }
      })();
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

async function openTab(type, targetUrl = null) {
  const stateKey = type === 'main' ? 'mainTabId' : 'additionalTabId';
  
  if (state[stateKey]) {
    try {
      const tab = await chrome.tabs.get(state[stateKey]);
      if (tab && !tab.discarded) {
        debugLog(`Reusing existing ${type} tab ${state[stateKey]}`);
        if (targetUrl && tab.url !== targetUrl) {
          debugLog(`Navigating ${type} tab to target URL: ${targetUrl}`);
          await chrome.tabs.update(tab.id, { url: targetUrl });
          for (let i = 0; i < 25; i++) {
            try {
              const t = await chrome.tabs.get(tab.id);
              if (t.status === "complete") break;
            } catch(e) { break; }
            await sleep(400);
          }
        }
        return state[stateKey];
      }
    } catch (e) {
      state[stateKey] = null;
    }
  }

  debugLog(`Opening pinned Instagram ${type} tab...`);

  const tab = await chrome.tabs.create({
    url: targetUrl || randUrl(),
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

async function sendTaskToContent(tabType, taskType, taskData, targetUrl = null) {
  const tabId = await openTab(tabType, targetUrl);

  debugLog(`Sending '${taskType}' to tab ${tabId}`);

  // Ping first to confirm content script is alive
  let pingOk = false;
  let reloadCount = 0;

  while (!pingOk && reloadCount < 2) {
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
      reloadCount++;
      debugLog(`Content script not responding. Reloading tab (attempt ${reloadCount}/2)...`);
      await chrome.tabs.reload(tabId, { bypassCache: true });
      await sleep(8000); // Wait for load
    }
  }

  if (!pingOk) {
    const errObj = new Error("Content script still not responding after tab reloads");
    errObj.unreachableType = "instagram_reload_error";
    throw errObj;
  }

  debugLog(`[sendTaskToContent] Sending actual task ${taskType} to tab ${tabId}...`);
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "adblock:info:to-content",
      data: { type: taskType, data: taskData }
    });
    debugLog(`[sendTaskToContent] Task ${taskType} successfully sent. Response: ${JSON.stringify(response)}`);
    return response;
  } catch (err) {
    debugLog(`[sendTaskToContent] ERROR sending task ${taskType} to tab ${tabId}: ${err.message}`);
    throw err;
  }
}

async function sendToContentLite(tabType, taskType, taskData) {
  if (!state[tabType === 'main' ? 'mainTabId' : 'additionalTabId']) return null;
  const tabId = state[tabType === 'main' ? 'mainTabId' : 'additionalTabId'];

  try {
    const pingRes = await Promise.race([
      chrome.tabs.sendMessage(tabId, {
        type: "adblock:info:to-content",
        data: { type: "ping", data: {} }
      }),
      sleep(3000).then(() => null)
    ]);
    if (!pingRes) {
      debugLog(`[sendToContentLite] Content script busy, skipping ${taskType}`);
      return null;
    }

    const response = await chrome.tabs.sendMessage(tabId, {
      type: "adblock:info:to-content",
      data: { type: taskType, data: taskData }
    });
    return response;
  } catch (e) {
    debugLog(`[sendToContentLite] ${taskType} skipped: ${e.message}`);
    return null;
  }
}

// ---------------------------------------------------------------------------
// Listeners
// ---------------------------------------------------------------------------
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === "HUB_LOGIN") {
    handleLogin(message.payload.email, message.payload.password).catch(err => debugLog(`Login error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "FETCH_BROWSERS") {
    fetchBrowsers().catch(err => debugLog(`Fetch browsers error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_CONNECT") {
    handleConnect(message.payload.browserId, message.payload.browserLabel).catch(err => debugLog(`Connect error: ${err.message}`));
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_DISCONNECT") {
    stopEngine();
    chrome.alarms.clear("engine_heartbeat");
    closeTabs();
    state.browserId = null;
    state.browserLabel = null;
    state.stats = { completed: 0, failed: 0 };
    chrome.storage.local.remove(['browserId', 'browserLabel', 'stats']).catch(()=>null);
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
    stopEngine();
    closeTabs();
    sendResponse({ ok: true });
    return;
  }
  if (message.type === "HUB_RESUME_ENGINE") {
    debugLog("[Engine] Resumed by user. Opening tab eagerly.");
    chrome.storage.local.remove('wakeUpAt').catch(()=>null);
    startEngine();
    openTab('main').catch(err => debugLog(`Open tab error: ${err.message}`));
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
      }).catch(err => debugLog(`Auto-Login Sync storage error: ${err.message}`));
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
        try {
          let result = null;
          if (tabId && state.mainTabId && tabId === state.mainTabId) result = "main";
          if (tabId && state.additionalTabId && tabId === state.additionalTabId) result = "additional";
          sendResponse({ success: true, result });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true; // async response
    }

    // sleep: content script uses this to sleep without blocking
    if (taskType === "sleep") {
      const ms = taskData?.time || 1000;
      (async () => {
        try {
          await sleep(ms);
          sendResponse({ success: true, result: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
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

    // saveMessages: content script sends read receipts for processing
    if (taskType === "saveMessages") {
      (async () => {
        try {
          await processCollectedMessages(taskData?.readReceipts || []);
          sendResponse({ success: true, result: true });
        } catch (err) {
          sendResponse({ success: false, error: err.message });
        }
      })();
      return true;
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
