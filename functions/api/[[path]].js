import worker from '../core/index.js';

export async function onRequest(context) {
  const { request } = context;
  const url = new URL(request.url);
  let pathname = url.pathname;

  if (pathname.startsWith('/api')) {
    pathname = pathname.replace(/^\/api/, '') || '/';
  }

  url.pathname = pathname;

  const newRequest = new Request(url.toString(), request);
  return worker.fetch(newRequest, context.env, context);
}
