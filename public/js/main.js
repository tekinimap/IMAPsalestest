import { initializeApp, handleAdminClick, setupNavigation } from './app.js';

document.addEventListener('DOMContentLoaded', () => {
  setupNavigation();
  initializeApp();

  if (location.hash === '#admin') {
    setTimeout(handleAdminClick, 100);
  }
});
