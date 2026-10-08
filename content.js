(async function () {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  const normalize = (s) =>
    (s || "")
      .replace(/\s+/g, " ")
      .trim()
      .toLowerCase();

  async function getState() {
    return chrome.storage.local.get(["phase", "productTitle"]);
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
    return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
  }

  function allClickable() {
    return [...document.querySelectorAll("button, a, [role='button'], input[type='button'], input[type='submit']")].filter(visible);
  }

  function findByText(regex) {
    return allClickable().find((el) => regex.test(normalize(el.innerText || el.value)));
  }

  function pageText() {
    return normalize(document.body?.innerText || "");
  }

  function getProductTitle() {
    const h1 = document.querySelector("h1");
    if (h1?.innerText?.trim()) return h1.innerText.trim();
    const og = document.querySelector('meta[property="og:title"]');
    if (og?.content?.trim()) return og.content.trim();
    return document.title.replace(/\s*\|\s*Croma.*$/i, "").trim();
  }

  function isLoginRequired() {
    const t = pageText();
    return /sign in to continue|login to continue|please login|sign in\/register/.test(t);
  }

  function isOutOfStockMessage() {
    const t = pageText();
    return /out of stock|currently out of stock|not available/.test(t);
  }

  function isPaymentPage() {
    const t = pageText();
    const url = location.href.toLowerCase();

    return (
      /payment|checkout\/payment|place order|review order/.test(url) ||
      /payment|place order|review order|billing/.test(t)
    );
  }

  async function waitFor(fn, timeout = 15000, step = 500) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      const result = fn();
      if (result) return result;
      await sleep(step);
    }
    return null;
  }

  async function productFlow() {
    await sleep(1500);

    if (isLoginRequired()) {
      await report({ type: "LOGIN_REQUIRED" });
      return;
    }

    const title = getProductTitle();
    const addBtn = await waitFor(() => findByText(/^(add to cart|add to bag)$/i), 12000);

    if (!addBtn) {
      await report({
        type: "ERROR",
        message: "Add to Cart button not found"
      });
      return;
    }

    if (
      addBtn.disabled ||
      addBtn.getAttribute("aria-disabled") === "true" ||
      normalize(addBtn.className).includes("disabled")
    ) {
      await report({
        type: "PRODUCT_OUT_OF_STOCK",
        productTitle: title
      });
      return;
    }

    addBtn.click();

    await sleep(2500);

    const afterClickText = pageText();
    if (/(out of stock|currently out of stock|not available)/.test(afterClickText)) {
      await report({
        type: "PRODUCT_OUT_OF_STOCK",
        productTitle: title
      });
      return;
    }

    const cartBtn = findByText(/^(go to cart|view cart|cart)$/i);
    if (!cartBtn && !/added to cart|item added/.test(afterClickText)) {
      await report({
        type: "ERROR",
        message: "Cart confirmation not found"
      });
      return;
    }

    await report({
      type: "PRODUCT_ADDED",
      productTitle: title
    });
  }

  async function cartFlow() {
    await sleep(1800);

    if (isLoginRequired()) {
      await report({ type: "LOGIN_REQUIRED" });
      return;
    }

    const state = await getState();
    const title = state.productTitle || getProductTitle();

    if (isOutOfStockMessage()) {
      await report({
        type: "CART_UNAVAILABLE",
        productTitle: title
      });
      return;
    }

    const checkoutBtn = await waitFor(
      () => findByText(/^(checkout|proceed to checkout|proceed to payment|place order)$/i),
      12000
    );

    if (!checkoutBtn) {
      await report({
        type: "ERROR",
        message: "Checkout button not found"
      });
      return;
    }

    checkoutBtn.click();
    await report({ type: "CHECKOUT_CLICKED", productTitle: title });

    const paymentReached = await waitFor(() => isPaymentPage(), 12000);

    if (paymentReached) {
      await report({
        type: "PAYMENT_REACHED",
        productTitle: title
      });
      return;
    }

    await report({
      type: "PAYMENT_NOT_REACHED",
      productTitle: title
    });
  }

  const state = await getState();
  if (state.phase === "PRODUCT") {
    await productFlow();
  } else if (state.phase === "CART") {
    await cartFlow();
  }
})();