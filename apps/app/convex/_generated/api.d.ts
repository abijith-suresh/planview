/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as betterAuth__generated_api from "../betterAuth/_generated/api.js";
import type * as betterAuth__generated_component from "../betterAuth/_generated/component.js";
import type * as betterAuth__generated_dataModel from "../betterAuth/_generated/dataModel.js";
import type * as betterAuth__generated_server from "../betterAuth/_generated/server.js";
import type * as betterAuth_auth from "../betterAuth/auth.js";
import type * as documents from "../documents.js";
import type * as http from "../http.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  "betterAuth/_generated/api": typeof betterAuth__generated_api;
  "betterAuth/_generated/component": typeof betterAuth__generated_component;
  "betterAuth/_generated/dataModel": typeof betterAuth__generated_dataModel;
  "betterAuth/_generated/server": typeof betterAuth__generated_server;
  "betterAuth/auth": typeof betterAuth_auth;
  documents: typeof documents;
  http: typeof http;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {
  betterAuth: import("@convex-dev/better-auth/_generated/component.js").ComponentApi<"betterAuth">;
};
