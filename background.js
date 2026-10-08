const ALARM_NAME = "croma-stock-check";
const CROMA_CART_URL = "https://www.croma.com/cart";

let activeRun = false;

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: false,
    interval: 5,
    lastStatus: "Ready"
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "START") {
        await startMonitoring();
        sendResponse({ ok: true });
      } else if (message.type === "STOP") {
        await stopMonitoring();
        sendResponse({ ok: true });
      } else if (message.type === "CHECK_NOW") {
        await runCheck();
        sendResponse({ ok: true });
      } else if (message.type === "PAGE_RESULT") {
        await handlePageResult(message.payload, sender.tab);
        sendResponse({ ok: true });
      }
    } catch (e) {
      await setStatus("ERROR: " + e.message);
      sendResponse({ ok: false, error: e.message });
    }
  })();
  return true;
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;
  const { enabled } = await chrome.storage.local.get("enabled");
  if (enabled) await runCheck();
});

async function startMonitoring() {
  const { interval = 5 } = await chrome.storage.local.get("interval");
  await chrome.storage.local.set({ enabled: true });
  await chrome.alarms.clear(ALARM_NAME);
  chrome.alarms.create(ALARM_NAME, {
    periodInMinutes: Math.max(1, Number(interval))
  });
  await runCheck();
}

async function stopMonitoring() {
  await chrome.alarms.clear(ALARM_NAME);
  activeRun = false;
  await chrome.storage.local.set({
    enabled: false,
    phase: null,
    activeTabId: null,
    lastStatus: "Stopped"
  });
}

async function runCheck() {
  if (activeRun) return;
  activeRun = true;

  const cfg = await chrome.storage.local.get([
    "productUrl", "botToken", "chatId", "productTitle",
    "cartReady"
  ]);

  if (!cfg.productUrl) {
    activeRun = false;
    throw new Error("Product URL missing.");
  }

  await setStatus("Opening live Croma tab…");

  // If we already added this product once, go directly to cart on later cycles.
  // If cart verification says the item disappeared, content.js will ask us
  // to reopen the product and add it again.
  const firstUrl = cfg.cartReady ? CROMA_CART_URL : cfg.productUrl;
  const phase = cfg.cartReady ? "VERIFY_CART" : "PRODUCT";

  const tab = await chrome.tabs.create({ url: firstUrl, active: true });

  await chrome.storage.local.set({
    phase,
    activeTabId: tab.id,
    lastChecked: Date.now()
  });
}

async function handlePageResult(payload, tab) {
  if (!tab?.id) return;

  const state = await chrome.storage.local.get([
    "activeTabId", "productUrl", "botToken", "chatId", "productTitle"
  ]);

  if (tab.id !== state.activeTabId) return;

  if (payload.type === "PRODUCT_OUT_OF_STOCK") {
    await setStatus("OUT OF STOCK on product page");
    await finishRun(tab.id);
    return;
  }

  if (payload.type === "PRODUCT_ADDED") {
    if (payload.productTitle) {
      await chrome.storage.local.set({ productTitle: payload.productTitle });
    }
    await chrome.storage.local.set({
      phase: "VERIFY_CART",
      cartReady: true
    });
    await setStatus("Added to cart. Verifying cart…");
    await chrome.tabs.update(tab.id, { url: CROMA_CART_URL });
    return;
  }

  if (payload.type === "ALREADY_IN_CART") {
    if (payload.productTitle) {
      await chrome.storage.local.set({ productTitle: payload.productTitle });
    }
    await chrome.storage.local.set({
      phase: "VERIFY_CART",
      cartReady: true
    });
    await setStatus("Product already in cart. Verifying…");
    await chrome.tabs.update(tab.id, { url: CROMA_CART_URL });
    return;
  }

  if (payload.type === "CART_AVAILABLE") {
    const title = payload.productTitle || state.productTitle || "Croma product";
    await setStatus("AVAILABLE in cart ✅");

    await sendTelegram(
      state.botToken,
      state.chatId,
      `✅ CROMA STOCK AVAILABLE\n\n${title}\n${state.productUrl}\n\nCart verification successful.`
    );

    // Stop after a positive hit to avoid repeated Telegram spam.
    await chrome.storage.local.set({ enabled: false });
    await chrome.alarms.clear(ALARM_NAME);
    await finishRun(tab.id);
    return;
  }

  if (payload.type === "CART_UNAVAILABLE") {
    await setStatus("NOT AVAILABLE in cart");
    await finishRun(tab.id);
    return;
  }

  if (payload.type === "CART_ITEM_MISSING") {
    await setStatus("Item missing from cart. Re-adding product…");
    await chrome.storage.local.set({
      phase: "PRODUCT",
      cartReady: false
    });
    await chrome.tabs.update(tab.id, { url: state.productUrl });
    return;
  }

  if (payload.type === "LOGIN_REQUIRED") {
    await setStatus("LOGIN REQUIRED — Croma me login karo");
    await finishRun(tab.id, false);
    return;
  }

  if (payload.type === "ERROR") {
    await setStatus("ERROR: " + payload.message);
    await finishRun(tab.id);
  }
}

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) throw new Error("Telegram config missing.");

  const url = `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`;

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      chat_id: chatId,
      text,
      disable_web_page_preview: false
    })
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.description || `Telegram HTTP ${res.status}`);
  }
}

async function setStatus(text) {
  await chrome.storage.local.set({
    lastStatus: text,
    lastChecked: Date.now()
  });
}

async function finishRun(tabId, closeTab = true) {
  activeRun = false;
  await chrome.storage.local.set({
    phase: null,
    activeTabId: null
  });

  if (closeTab) {
    try { await chrome.tabs.remove(tabId); } catch {}
  }
}