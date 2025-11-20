const navigationViews = {
  erfassung: null,
  fixauftraege: null,
  rahmen: null,
  rahmenDetails: null,
  admin: null,
  analytics: null,
};

let navLinks = [];
let deps = {};

function ensureViewsInitialized() {
  if (navigationViews.erfassung) return;
  navigationViews.erfassung = document.getElementById('viewErfassung');
  navigationViews.fixauftraege = document.getElementById('viewFixauftraege');
  navigationViews.rahmen = document.getElementById('viewRahmen');
  navigationViews.rahmenDetails = document.getElementById('viewRahmenDetails');
  navigationViews.admin = document.getElementById('viewAdmin');
  navigationViews.analytics = document.getElementById('viewAnalytics');
}

function registerNavLinks() {
  navLinks = Array.from(document.querySelectorAll('.nav-link'));

  navLinks.forEach((link) => {
    link.addEventListener('click', (event) => {
      event.preventDefault();
      handleNavigation(link.dataset.view);
    });
  });
}

export function initNavigation(navigationDeps) {
  deps = navigationDeps;
  ensureViewsInitialized();
  registerNavLinks();
}

function handleNavigation(viewName) {
  if (!viewName) return;
  if (deps.getIsBatchRunning?.()) {
    deps.showToast?.('Bitte warten Sie, bis die aktuelle Verarbeitung abgeschlossen ist.', 'bad');
    return;
  }

  const viewHandlers = {
    fixauftraege: () => deps.onShowFixauftraege?.(),
    rahmen: () => deps.onShowRahmen?.(),
    analytics: () => deps.onShowAnalytics?.(),
    admin: () => deps.onShowAdmin?.(),
    erfassung: () => deps.onShowErfassung?.(),
  };

  const handler = viewHandlers[viewName];
  if (handler) {
    handler();
  } else {
    showView(viewName);
  }
}

export function showView(viewName) {
  ensureViewsInitialized();

  if (deps.getIsBatchRunning?.()) {
    deps.showToast?.('Bitte warten Sie, bis die aktuelle Verarbeitung abgeschlossen ist.', 'bad');
    return;
  }

  Object.values(navigationViews).forEach((view) => view?.classList.add('hide'));
  navLinks.forEach((link) => link.classList.remove('active'));
  deps.hideBatchProgress?.();

  const targetView = navigationViews[viewName];
  if (targetView) {
    targetView.classList.remove('hide');
    navLinks
      .find((link) => link.dataset.view === viewName)
      ?.classList.add('active');
  }
  window.scrollTo(0, 0);
}

export function isViewVisible(viewName) {
  ensureViewsInitialized();
  const targetView = navigationViews[viewName];
  return !!targetView && !targetView.classList.contains('hide');
}
