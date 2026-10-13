// Tab switching, range pickers and the theme toggle for the static mocks.
document.querySelectorAll("[data-tabs]").forEach((group) => {
  const buttons = group.querySelectorAll("[data-tab]");
  const scope = document.querySelector(group.dataset.tabs) || document;
  const show = (id) => {
    buttons.forEach((b) => b.classList.toggle("on", b.dataset.tab === id));
    scope.querySelectorAll("[data-panel]").forEach((p) => p.classList.toggle("on", p.dataset.panel === id));
    if (location.hash !== "#" + id) history.replaceState(null, "", "#" + id);
  };
  buttons.forEach((b) => b.addEventListener("click", () => show(b.dataset.tab)));
  const isTab = (id) => [...buttons].some((b) => b.dataset.tab === id);
  window.addEventListener("hashchange", () => {
    const id = location.hash.slice(1);
    if (isTab(id)) show(id);
  });
  const initial = location.hash.slice(1);
  show(isTab(initial) ? initial : buttons[0].dataset.tab);
});
document.querySelectorAll(".range").forEach((r) =>
  r.addEventListener("click", (e) => {
    if (e.target.tagName !== "BUTTON") return;
    r.querySelectorAll("button").forEach((b) => b.classList.toggle("on", b === e.target));
  }),
);
const themeBtn = document.querySelector("[data-theme-toggle]");
if (themeBtn) {
  const apply = (t) => document.documentElement.setAttribute("data-theme", t);
  apply(matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light");
  themeBtn.addEventListener("click", () => apply(document.documentElement.dataset.theme === "dark" ? "light" : "dark"));
}
