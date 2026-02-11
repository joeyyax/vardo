async (page) => {
  await page.evaluate(() => {
    const s = document.createElement("script");
    s.src = "http://localhost:3000/widget/scope.js";
    s.setAttribute("data-key", "sc_ecZV91FK0a1gV9VD6j9R_Gm2");
    document.head.appendChild(s);
  });
  await page.waitForTimeout(4000);
  return await page.evaluate(() => {
    const widget = document.getElementById("scope-widget");
    const iframe = document.querySelector("iframe[src*=bridge]");
    return {
      widgetExists: !!widget,
      iframeExists: !!iframe,
      iframeSrc: iframe ? iframe.src : null,
    };
  });
}
