const analyticsState = {
  analyticsData: { persons: [], teams: [], totals: [] },
  trendData: null,
};

export function getAnalyticsData() {
  return analyticsState.analyticsData;
}

export function setAnalyticsData(value) {
  analyticsState.analyticsData = value;
  return analyticsState.analyticsData;
}

export function getTrendData() {
  return analyticsState.trendData;
}

export function setTrendData(value) {
  analyticsState.trendData = value;
  return analyticsState.trendData;
}
