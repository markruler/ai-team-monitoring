/** Apply the saved or system theme before the body can paint; a classic script so it blocks rendering. */
{
  let saved = null;
  try { saved = localStorage.getItem('theme'); } catch { /* System preference remains available without storage. */ }
  const theme = ['light', 'dark'].includes(saved) ? saved : null;
  document.documentElement.dataset.theme = theme ?? (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
}
