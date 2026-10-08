const CART_URL = "https://www.croma.com/cart";

let activeRun = false;
let timerId = null;

async function getConfig() {
  return chrome.storage.local.get([
    "productUrls",
    "interval",
    "botToken",
    "chatId",
    "enabled",
    "lastStatus",
    "productTitle",
    "activeTabId",
    "phase",
    "queueIndex"
  ]);
}

async function setStatus(text) {
  await chrome.storage.local.set({
    lastStatus: text,
    lastChecked: Date.now()
  });
}

async function sendTelegram(token, chatId, text) {
  if (!token || !chatId) throw new Error("Telegram config missing.");

  const res = await fetch(
    `https://api.telegram.org/bot${encodeURIComponent(token)}/sendMessage`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        disable_web_page_preview: false
      })
    }
  );

  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.description || `Telegram HTTP ${res.status}`);
  }
}

async function stopMonitoring(reason = "Stopped") {
  if (timerId) clearTimeout(timerId);
  timerId = null;
  activeRun = false;

  try {
    const { activeTabId } = await chrome.storage.local.get("activeTabId");
    if (activeTabId) {
      await chrome.tabs.remove(activeTabId);
    }
  } catch {}

  await chrome.storage.local.set({
    enabled: false,
    phase: null,
    activeTabId: null,
    queueIndex: 0,
    lastStatus: reason
  });
}

async function scheduleNextCycle() {
  const { enabled, interval = 5 } = await chrome.storage.local.get([
    "enabled",
    "interval"
  ]);
  if (!enabled) return;

  if (timerId) clearTimeout(timerId);

  timerId = setTimeout(async () => {
    timerId = null;
    const cfg = await getConfig();
    if (cfg.enabled) {
      await runCheck();
    }
  }, Math.max(1, Number(interval)) * 1000);
}

async function runCheck() {
  if (activeRun) return;
  activeRun = true;

  try {
    const cfg = await getConfig();
    const productUrls = cfg.productUrls || [];

    if (!productUrls.length) {
      await setStatus("Product URL queue missing");
      activeRun = false;
      return;
    }

    const queueIndex = Number(cfg.queueIndex || 0);
    const nextIndex = queueIndex >= productUrls.length ? 0 : queueIndex;
    const productUrl = productUrls[nextIndex];

    await chrome.storage.local.set({
      phase: "PRODUCT",
      lastStatus: `Opening product ${nextIndex + 1}/${productUrls.length}...`,
      queueIndex: nextIndex
    });

    const tab = await chrome.tabs.create({
      url: productUrl,
      active: true
    });

    await chrome.storage.local.set({
      activeTabId: tab.id,
      lastChecked: Date.now()
    });
  } catch (e) {
    await setStatus("ERROR: " + e.message);
    activeRun = false;
    await scheduleNextCycle();
  }
}

async function handlePageResult(payload, senderTab) {
  const cfg = await getConfig();

  if (!senderTab?.id || cfg.activeTabId !== senderTab.id) return;

  if (payload.type === "LOGIN_REQUIRED") {
    await setStatus("LOGIN REQUIRED");
    await stopMonitoring("LOGIN REQUIRED");
    return;
  }

  if (payload.type === "PRODUCT_OUT_OF_STOCK") {
    await setStatus("OUT OF STOCK on product page");
    await chrome.tabs.remove(senderTab.id).catch(() => {});
    activeRun = false;

    const productUrls = cfg.productUrls || [];
    const nextIndex = ((cfg.queueIndex || 0) + 1) % productUrls.length;
    await chrome.storage.local.set({ queueIndex: nextIndex });

    await scheduleNextCycle();
    return;
  }

  if (payload.type === "PRODUCT_ADDED") {
    await chrome.storage.local.set({
      phase: "CART",
      productTitle: payload.productTitle || cfg.productTitle || ""
    });
    await setStatus("Added to cart. Opening cart...");
    await chrome.tabs.update(senderTab.id, { url: CART_URL });
    return;
  }

  if (payload.type === "CART_UNAVAILABLE") {
    await setStatus("Cart says out of stock");
    await chrome.tabs.remove(senderTab.id).catch(() => {});
    activeRun = false;

    const productUrls = cfg.productUrls || [];
    const nextIndex = ((cfg.queueIndex || 0) + 1) % productUrls.length;
    await chrome.storage.local.set({ queueIndex: nextIndex });

    await scheduleNextCycle();
    return;
  }

  if (payload.type === "CHECKOUT_CLICKED") {
    await setStatus("Checkout clicked. Waiting for payment page...");
    return;
  }

  if (payload.type === "PAYMENT_REACHED") {
    const title = payload.productTitle || cfg.productTitle || "Croma product";
    const currentUrl = (cfg.productUrls || [])[cfg.queueIndex || 0] || "";

    await setStatus("PAYMENT PAGE REACHED ✅");

    await sendTelegram(
      cfg.botToken,
      cfg.chatId,
      `✅ CROMA STOCK CONFIRMED\n\n${title}\n${currentUrl}\n\nPayment page reached successfully.`
    );

    await stopMonitoring("SUCCESS");
    return;
  }

  if (payload.type === "PAYMENT_NOT_REACHED") {
    await setStatus("Payment page not reached");
    await chrome.tabs.remove(senderTab.id).catch(() => {});
    activeRun = false;

    const productUrls = cfg.productUrls || [];
    const nextIndex = ((cfg.queueIndex || 0) + 1) % productUrls.length;
    await chrome.storage.local.set({ queueIndex: nextIndex });

    await scheduleNextCycle();
    return;
  }

  if (payload.type === "ERROR") {
    await setStatus("ERROR: " + payload.message);
    await chrome.tabs.remove(senderTab.id).catch(() => {});
    activeRun = false;

    const productUrls = cfg.productUrls || [];
    const nextIndex = ((cfg.queueIndex || 0) + 1) % productUrls.length;
    await chrome.storage.local.set({ queueIndex: nextIndex });

    await scheduleNextCycle();
    return;
  }
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.storage.local.set({
    enabled: false,
    interval: 5,
    queueIndex: 0,
    lastStatus: "Ready"
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  (async () => {
    try {
      if (message.type === "START") {
        await chrome.storage.local.set({ enabled: true, queueIndex: 0 });
        await runCheck();
        sendResponse({ ok: true });
      } else if (message.type === "STOP") {
        await stopMonitoring("Stopped by user");
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