import { initializeApp, handleAdminClick } from './app.js';

document.addEventListener('DOMContentLoaded', () => {
  initializeApp();

  if (location.hash === '#admin') {
    setTimeout(handleAdminClick, 100);
  }
});
