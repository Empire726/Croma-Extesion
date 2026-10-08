const $ = (id) => document.getElementById(id);

async function load() {
  const data = await chrome.storage.local.get([
    "productUrl", "interval", "botToken", "chatId",
    "enabled", "lastStatus", "lastChecked"
  ]);

  $("productUrl").value = data.productUrl || "";
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
    `Last: ${data.lastStatus || "—"}\n` +
    `Checked: ${checked}`;
}

async function saveSettings() {
  const productUrl = $("productUrl").value.trim();
  const interval = Math.max(1, Number($("interval").value || 5));
  const botToken = $("botToken").value.trim();
  const chatId = $("chatId").value.trim();

  if (!/^https:\/\/(www\.)?croma\.com\//i.test(productUrl)) {
    throw new Error("Valid Croma product URL daalo.");
  }
  if (!botToken || !chatId) {
    throw new Error("Telegram Bot Token aur Chat ID required hain.");
  }

  await chrome.storage.local.set({ productUrl, interval, botToken, chatId });
  return { productUrl, interval, botToken, chatId };
}

$("start").addEventListener("click", async () => {
  try {
    await saveSettings();
    await chrome.runtime.sendMessage({ type: "START" });
    await load();
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
  }
});

$("checkNow").addEventListener("click", async () => {
  try {
    await saveSettings();
    await chrome.runtime.sendMessage({ type: "CHECK_NOW" });
    await load();
  } catch (e) {
    $("status").textContent = "Error: " + e.message;
  }
});

$("stop").addEventListener("click", async () => {
  await chrome.runtime.sendMessage({ type: "STOP" });
  await load();
});

chrome.storage.onChanged.addListener(() => load());
load();