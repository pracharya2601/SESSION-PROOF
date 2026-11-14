/** Success envelope helper shared by API routers (Agents 15/16). */
import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ApiSuccess } from "../contracts";
import type { AppBindings } from "./deps";

export function ok<T>(c: Context<AppBindings>, data: T, status: ContentfulStatusCode = 200) {
  const body: ApiSuccess<T> = { data, correlationId: c.get("correlationId") ?? "" };
  return c.json(body, status);
}
