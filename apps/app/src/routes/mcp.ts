import { handleHostedMcp } from "~/lib/hosted-mcp";

export const POST = ({ request }: { request: Request }) => handleHostedMcp(request);
export const GET = ({ request }: { request: Request }) => handleHostedMcp(request);
export const DELETE = ({ request }: { request: Request }) => handleHostedMcp(request);
