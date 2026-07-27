// Dark/light theme toggle. By default the app follows the system/browser
// preference (see the @media(prefers-color-scheme:dark) rule in
// style.css). This file lets the user override that with an explicit
// choice, saved in localStorage so it persists across visits, via the
// button added next to "Update" in the header.
(function () {
  const STORAGE_KEY = "rd-theme"; // "dark" | "light", absent = follow system
  const root = document.documentElement;
  const darkMediaQuery = matchMedia("(prefers-color-scheme: dark)");

  function explicitTheme() {
    return root.getAttribute("data-theme"); // "dark" | "light" | null
  }

  function isDark() {
    const explicit = explicitTheme();
    return explicit ? explicit === "dark" : darkMediaQuery.matches;
  }

  function updateMetaThemeColor() {
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", isDark() ? "#121211" : "#fcfcfb");
  }

  function updateIcon() {
    const icon = document.getElementById("themeIcon");
    if (icon) icon.textContent = isDark() ? "☀️" : "🌙";
  }

  // Chart.js instances bake the grid color in at creation time via
  // getGridColor(), so switching themes requires dropping every existing
  // chart and letting the normal dirty-flag render cycle recreate them.
  function redrawCharts() {
    const state = window.RD && window.RD.state;
    if (!state) return;
    state.destroyAllCharts();
    state.markAllDirty();
    if (typeof window.RD.renderActiveTab === "function") window.RD.renderActiveTab();
  }

  function applyTheme() {
    updateMetaThemeColor();
    updateIcon();
    redrawCharts();
  }

  function setTheme(value) {
    if (value === "dark" || value === "light") {
      root.setAttribute("data-theme", value);
      localStorage.setItem(STORAGE_KEY, value);
    } else {
      root.removeAttribute("data-theme");
      localStorage.removeItem(STORAGE_KEY);
    }
    applyTheme();
  }

  function toggleTheme() {
    setTheme(isDark() ? "light" : "dark");
  }

  // Restore a previously saved explicit choice, if any.
  const saved = localStorage.getItem(STORAGE_KEY);
  if (saved === "dark" || saved === "light") root.setAttribute("data-theme", saved);
  updateMetaThemeColor();
  updateIcon();

  // If the user hasn't made an explicit choice, keep following the
  // system preference live (e.g. iOS switching to Night Shift/dark mode).
  darkMediaQuery.addEventListener("change", () => { if (!explicitTheme()) applyTheme(); });

  document.getElementById("themeBtn")?.addEventListener("click", toggleTheme);

  window.RD = window.RD || {};
  window.RD.theme = { isDark, setTheme, toggleTheme };
})();
