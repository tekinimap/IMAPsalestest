import { initializeApp, handleAdminClick, setupNavigation, initializeCommonEvents } from './app.js';

function bootstrap() {
  initializeCommonEvents();
  setupNavigation();
  initializeApp();

  if (location.hash === '#admin') {
    setTimeout(handleAdminClick, 100);
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bootstrap);
} else {
  bootstrap();
}
