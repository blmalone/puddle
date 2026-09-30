// Loaded before styles so a saved dark preference does not flash a light page.
(() => {
  const key = 'private-deposit-theme';
  let dark = false;
  try {
    // Preserve the original demo preference; future renames use the same key.
    const preference = localStorage.getItem(key) ?? localStorage.getItem('jumpr-theme');
    dark = preference === 'dark';
    if (preference) localStorage.setItem(key, preference);
    localStorage.removeItem('jumpr-theme');
  } catch { /* Storage may be disabled. */ }

  function apply() {
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#111113' : '#fafaf9');
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === (dark ? 'dark' : 'light')));
    }
  }
  function select(value: boolean) {
    dark = value;
    apply();
    try { localStorage.setItem(key, dark ? 'dark' : 'light'); } catch { /* The current session still works. */ }
  }
  apply();
  document.addEventListener('DOMContentLoaded', () => {
    apply();
    for (const button of document.querySelectorAll<HTMLButtonElement>('[data-theme-choice]')) {
      button.addEventListener('click', () => select(button.dataset.themeChoice === 'dark'));
    }
  });
})();
