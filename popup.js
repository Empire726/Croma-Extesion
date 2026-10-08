const $ = (id) => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get([
    "productUrls",
    "interval",
    "botToken",
    "chatId",
    "enabled",
    "lastStatus",
    "lastChecked",
    "productTitle",
    "queueIndex"
  ]);

  $("productUrls").value = (data.productUrls || []).join("\n");
  $("interval").value = data.interval || 5;
  $("botToken").value = data.botToken || "";
  $("chatId").value = data.chatId || "";

  renderStatus(data);
}

function renderStatus(data) {
  const checked = data.lastChecked
    ? new Date(data.lastChecked).toLocaleString()
    : "Never";

  $("status").textContent =
    `Running: ${data.enabled ? "YES" : "NO"}\n` +
    `Queue Index: ${data.queueIndex ?? 0}\n` +
    `Last: ${data.lastStatus || "—"}\n` +
    `Checked: ${checked}\n` +
    `Product: ${data.productTitle || "—"}`;
}

async function saveSettings() {
  const productUrls = $("productUrls").value
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  const interval = Math.max(1, Number($("interval").value || 5));
  const botToken = $("botToken").value.trim();
  const chatId = $("chatId").value.trim();

  if (!productUrls.length) {
    throw new Error("At least 1 Croma product URL do.");
  }

  for (const url of productUrls) {
    if (!/^https:\/\/(www\.)?croma\.com\//i.test(url)) {
      throw new Error("Sirf valid Croma URLs daalo.");
    }
  }

  if (!botToken || !chatId) {
    throw new Error("Telegram Bot Token aur Chat ID required hain.");
  }

  await chrome.storage.local.set({
    productUrls,
    interval,
    botToken,
    chatId
  });

  return { productUrls, interval, botToken, chatId };
}

async function setStatus(text) {
  await chrome.storage.local.set({
    lastStatus: text,
    lastChecked: Date.now()
  });
}

$("start").addEventListener("click", async () => {
  try {
    await saveSettings();
    await chrome.runtime.sendMessage({ type: "START" });
    await setStatus("Started");
    await load();
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
  }
});

$("checkNow").addEventListener("click", async () => {
  try {
    await saveSettings();
    await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
    await setStatus("Manual check triggered");
    await load();
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
  }
});

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP" });
  await setStatus("Stopped");
  await load();
});

chrome.storage.onChanged.addListener(() => load());
load();