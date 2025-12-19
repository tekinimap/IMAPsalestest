const escapeRegex = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const compilePath = (path) => {
  const segments = path.split('/').filter(Boolean);
  const keys = [];
  const regexParts = segments.map((segment) => {
    if (segment.startsWith(':')) {
      keys.push(segment.slice(1));
      return '([^/]+)';
    }
    return escapeRegex(segment);
  });

  const regex = new RegExp(`^/${regexParts.join('/')}$`);
  return { regex, keys };
};

export const normalizePathname = (pathname = '/') => {
  const normalized = String(pathname || '/').replace(/\/+$/, '');
  return normalized || '/';
};

export function createRouter() {
  const routes = [];

  const addRoute = (method, path, handler) => {
    routes.push({ method: method.toUpperCase(), handler, ...compilePath(path) });
  };

  const handle = async (request, context = {}) => {
    const url = context.url || new URL(request.url);
    const pathname = normalizePathname(context.pathname || url.pathname);
    const method = String(request.method || 'GET').toUpperCase();

    for (const route of routes) {
      if (route.method !== method) continue;
      const match = pathname.match(route.regex);
      if (!match) continue;

      const params = {};
      route.keys.forEach((key, idx) => {
        params[key] = decodeURIComponent(match[idx + 1] || '');
      });

      return route.handler({
        ...context,
        request,
        url,
        pathname,
        params,
      });
    }

    return null;
  };

  return {
    get: (path, handler) => addRoute('GET', path, handler),
    post: (path, handler) => addRoute('POST', path, handler),
    put: (path, handler) => addRoute('PUT', path, handler),
    delete: (path, handler) => addRoute('DELETE', path, handler),
    handle,
  };
}
