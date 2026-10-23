(function () {
  try {
    var saved = localStorage.getItem('mytodo_theme');
    document.documentElement.setAttribute('data-theme', saved === 'light' ? 'light' : 'dark');
  } catch (e) { /* storage blocked: stay dark */ }
})();
