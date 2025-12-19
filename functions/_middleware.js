export async function onRequest(context, next) {
  const emailHeader = context.request.headers.get('CF-Access-Authenticated-User-Email');
  const jwtHeader = context.request.headers.get('CF-Access-Jwt-Assertion');

  const email = emailHeader && emailHeader.trim()
    ? emailHeader.trim()
    : 'dev@local.test';
  const name = emailHeader && emailHeader.trim()
    ? email
    : 'Local Dev';

  context.data ||= {};
  context.data.user = {
    email,
    name,
    jwt: jwtHeader ? jwtHeader.trim() : '',
  };

  return next();
}
