(async function () {
  const sleep = (ms) => new Promise(r => setTimeout(r, ms));

  const normalize = (s) => (s || "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();

  async function getState() {
    return chrome.storage.local.get([
      "phase", "activeTabId", "productTitle"
    ]);
  }

  async function report(payload) {
    try {
      await chrome.runtime.sendMessage({
        type: "PAGE_RESULT",
        payload
      });
    } catch {}
  }

  function visible(el) {
    if (!el) return false;
    const style = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0;
  }

  function allClickable() {
    return [...document.querySelectorAll(
      'button, a, [role="button"], input[type="button"], input[type="submit"]'
    )].filter(visible);
  }

  function findByText(regex) {
    return allClickable().find(el => regex.test(normalize(el.innerText || el.value)));
  }

  function pageText() {
    return normalize(document.body?.innerText || "");
  }

  function getProductTitle() {
    const candidates = [
      document.querySelector("h1"),
      document.querySelector('[data-testid*="product"] h1'),
      document.querySelector('meta[property="og:title"]')
    ].filter(Boolean);

    for (const el of candidates) {
      const text = el.content || el.innerText || "";
      if (text.trim()) return text.trim();
    }
    return document.title.replace(/\s*\|\s*Croma.*$/i, "").trim();
  }

  function loginRequired() {
    const t = pageText();
    return /sign in to continue|login to continue|please login|sign in\/register/.test(t);
  }

  async function waitFor(condition, timeout = 20000, step = 500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = condition();
      if (result) return result;
      await sleep(step);
    }
    return null;
  }

  async function productPhase() {
    await sleep(1800);

    if (loginRequired()) {
      await report({ type: "LOGIN_REQUIRED" });
      return;
    }

    const title = getProductTitle();
    const text = pageText();

    if (
      /out of stock|currently unavailable|notify me when available/.test(text) &&
      !findByText(/add to cart|add to bag|buy now/)
    ) {
      await report({
        type: "PRODUCT_OUT_OF_STOCK",
        productTitle: title
      });
      return;
    }

    const already = findByText(/go to cart|view cart/);
    if (already) {
      await report({
        type: "ALREADY_IN_CART",
        productTitle: title
      });
      return;
    }

    const addBtn = await waitFor(() =>
      findByText(/^(add to cart|add to bag)$/)
    );

    if (!addBtn) {
      await report({
        type: "ERROR",
        message: "Add to Cart button nahi mila. Croma DOM/selector change ho sakta hai."
      });
      return;
    }

    const disabled =
      addBtn.disabled ||
      addBtn.getAttribute("aria-disabled") === "true" ||
      normalize(addBtn.className).includes("disabled");

    if (disabled) {
      await report({
        type: "PRODUCT_OUT_OF_STOCK",
        productTitle: title
      });
      return;
    }

    addBtn.click();

    const success = await waitFor(() => {
      const t = pageText();
      return (
        findByText(/go to cart|view cart/) ||
        /added to cart|added to your cart|item added/.test(t)
      );
    }, 12000);

    if (!success) {
      // Even if toast is missed, Croma may have added successfully.
      // Background will verify the cart next.
    }

    await report({
      type: "PRODUCT_ADDED",
      productTitle: title
    });
  }

  async function cartPhase() {
    await sleep(2200);

    if (loginRequired()) {
      await report({ type: "LOGIN_REQUIRED" });
      return;
    }

    const state = await getState();
    const wanted = normalize(state.productTitle);
    const text = pageText();

    // Empty-cart / removed-item cases.
    if (
      /your cart is empty|cart is empty|no items in your cart/.test(text)
    ) {
      await report({ type: "CART_ITEM_MISSING" });
      return;
    }

    // Try to locate the specific product container by title.
    let productNode = null;
    if (wanted) {
      const nodes = [...document.querySelectorAll("body *")].filter(el => {
        if (!visible(el)) return false;
        const tx = normalize(el.innerText);
        return tx && tx.includes(wanted.slice(0, Math.min(45, wanted.length)));
      });

      // Prefer a reasonably small card/container.
      productNode = nodes
        .filter(el => (el.innerText || "").length < 2500)
        .sort((a, b) => (a.innerText || "").length - (b.innerText || "").length)[0] || null;
    }

    const scopeText = normalize(productNode?.innerText || text);

    const unavailablePatterns = [
      /out of stock/,
      /currently unavailable/,
      /not available/,
      /unavailable for delivery/,
      /cannot be delivered/,
      /not deliverable/,
      /remove this item to proceed/
    ];

    if (unavailablePatterns.some(r => r.test(scopeText))) {
      await report({
        type: "CART_UNAVAILABLE",
        productTitle: state.productTitle || ""
      });
      return;
    }

    // Strong positive signals: item exists in cart + no unavailable marker.
    const hasItem = wanted
      ? scopeText.includes(wanted.slice(0, Math.min(35, wanted.length)))
      : /cart|shopping bag/.test(text);

    const checkoutButton = findByText(
      /checkout|proceed to checkout|proceed to payment|place order/
    );

    if (hasItem && (checkoutButton || !/out of stock|currently unavailable/.test(scopeText))) {
      await report({
        type: "CART_AVAILABLE",
        productTitle: state.productTitle || ""
      });
      return;
    }

    await report({
      type: "CART_ITEM_MISSING",
      productTitle: state.productTitle || ""
    });
  }

  const state = await getState();

  // Only act in the exact tab opened by the extension.
  if (!state.activeTabId) return;

  if (state.phase === "PRODUCT") {
    await productPhase();
  } else if (state.phase === "VERIFY_CART") {
    await cartPhase();
  }
})();