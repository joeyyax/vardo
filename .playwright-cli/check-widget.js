async (page) => {
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
