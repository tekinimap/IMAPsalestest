import { initializeApp, handleAdminClick, setupNavigation } from './app.js';

function bootstrap() {
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
