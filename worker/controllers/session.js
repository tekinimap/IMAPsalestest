export function registerSessionRoutes(router, { resolveAccessIdentity }) {
  router.get('/session', async ({ request, env, respond, peoplePath, branch }) => {
    const identity = await resolveAccessIdentity(request, env, branch, peoplePath);
    const person = identity.person
      ? {
          id: identity.person.id,
          name: identity.person.name,
          team: identity.person.team || '',
          email: identity.person.email || '',
        }
      : null;

    return respond({
      email: identity.email,
      name: identity.name,
      rawName: identity.rawName,
      person,
    });
  });
}
