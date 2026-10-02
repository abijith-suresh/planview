const signInLocation = new URL("/", "http://localhost").pathname;

export const GET = () =>
  new Response(null, {
    status: 302,
    headers: { Location: signInLocation },
  });
