// newtypes.ts
// ---------------------------------------------------------------------------
// Lightweight nominal types for model auth and harness construction. They stay
// plain primitives at runtime while giving TypeScript a one-way branded gate.
// ---------------------------------------------------------------------------

declare const brand: unique symbol;
type Newtype<T, B extends string> = T & { readonly [brand]: B };

export type RepoPath = Newtype<string, "RepoPath">;
export const RepoPath = (value: string): RepoPath => value as RepoPath;

export type ApiKey = Newtype<string, "ApiKey">;
export const ApiKey = (value: string): ApiKey => value as ApiKey;

export type HttpProxyUrl = Newtype<string, "HttpProxyUrl">;
export const HttpProxyUrl = (value: string): HttpProxyUrl => value as HttpProxyUrl;

export type ModelId = Newtype<string, "ModelId">;
export const ModelId = (value: string): ModelId => value as ModelId;
