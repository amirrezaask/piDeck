try {
  if (localStorage.getItem('pideck-theme') === 'dark') {
    document.documentElement.classList.add('dark');
    document.documentElement.style.colorScheme = 'dark';
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', '#171717');
  }
} catch {
  // Ignore unavailable storage in privacy-restricted browsers.
}
