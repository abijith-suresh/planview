const cookieName = "planview_auth_attempt";

export const authAttemptCookie = `${cookieName}=1; Path=/; Max-Age=600; SameSite=Lax; Secure`;
export const clearAuthAttemptCookie = `${cookieName}=; Path=/; Max-Age=0; SameSite=Lax; Secure`;

export function hasAuthAttemptCookie(cookieHeader: string) {
  return cookieHeader.split(";").some((cookie) => cookie.trim() === `${cookieName}=1`);
}
