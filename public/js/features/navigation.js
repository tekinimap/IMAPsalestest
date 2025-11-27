const navigationViews = {
  erfassung: null,
  portfolio: null,
  analytics: null,
  admin: null,
  rahmenDetails: null
};

let navLinks = [];
let deps = {};

function isNavigationBlockedByBatch() {
  const running = deps.getIsBatchRunning?.();
  if (!running) return false;

  const batchProgress = document.getElementById('batchProgress');
  const batchHidden = batchProgress?.classList.contains('hide');

  // Falls der Zustand hängengeblieben ist (kein sichtbarer Fortschrittsbalken),
  // räumen wir auf und blockieren die Navigation nicht weiter.
  if (batchHidden) {
    deps.hideBatchProgress?.();
    return false;
  }

  return true;
}

function ensureViewsInitialized() {
  if (navigationViews.erfassung) return;
  navigationViews.erfassung = document.getElementById('viewErfassung');
  navigationViews.portfolio = document.getElementById('viewPortfolio');
  navigationViews.analytics = document.getElementById('viewAnalytics');
  navigationViews.admin = document.getElementById('viewAdmin');
  navigationViews.rahmenDetails = document.getElementById('viewRahmenDetails');
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
  if (isNavigationBlockedByBatch()) {
    deps.showToast?.('Bitte warten Sie, bis die aktuelle Verarbeitung abgeschlossen ist.', 'bad');
    return;
  }

  const viewHandlers = {
    erfassung: () => deps.onShowErfassung?.(),
    portfolio: () => deps.onShowPortfolio?.(),
    analytics: () => deps.onShowAnalytics?.(),
    admin: () => deps.onShowAdmin?.()
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

  if (isNavigationBlockedByBatch()) {
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
