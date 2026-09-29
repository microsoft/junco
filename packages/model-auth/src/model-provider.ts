// model-provider.ts
// ---------------------------------------------------------------------------
// ModelProvider: owns authentication + model resolution. It is orthogonal to
// any repository — construction takes only auth config. Callers resolve a model
// via `resolveModel` and build their own AgentHarness (see junco-agent).
//
// Construct it one of three ways:
//   ModelProvider.apiKey({ apiKey? })      // apiKey optional; falls back to the
//                                          // provider's env var
//   ModelProvider.githubCopilot()          // OAuth; opens the browser / shows a
//                                          // device code if no stored credential
//   ModelProvider.httpProxy({              // baseUrl override; proxy owns auth
//     httpProxyUrl
//   })
//
// Then: const { models, model } = await provider.resolveModel(ModelId("..."))
//       and hand { models, model } to an AgentHarness.
//
// Auth runs lazily and exactly once (memoized), so resolving several models
// triggers a single login. The flow is driven entirely by pi-ai's auth API:
//   - Models.getAuth(model)        : is this provider already configured?
//   - provider.auth.oauth.login()  : run the OAuth (GitHub device) flow
//   - credentials.modify(id, ...)  : persist the resulting credential
// ---------------------------------------------------------------------------
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import * as readline from "node:readline/promises";

import {
  InMemoryCredentialStore,
  type Api,
  type AuthContext,
  type AuthLoginCallbacks,
  type CredentialStore,
  type Model,
  type MutableModels,
  type Models,
  type Provider,
} from "@earendil-works/pi-ai";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";

import { type ApiKey, type HttpProxyUrl, type ModelId } from "./newtypes.js";
import { discoverCopilotCliToken } from "./copilot-cli.js";

// Shared, auth-only knobs for both construction modes. Deliberately free of any
// repo/tool/harness concerns — authentication is orthogonal to the codebase.
export interface ModelProviderShared {
  /** Override the credential store (default: in-memory). */
  credentials?: CredentialStore;
  /** Override environment/file access used during auth resolution. */
  authContext?: AuthContext;
  /** Override the login UX (default: console messages + open browser). */
  callbacks?: AuthLoginCallbacks;
}

interface ResolvedConfig extends ModelProviderShared {
  providerId: string;
  /** Explicit api key (api-key mode only); undefined means "use ambient env". */
  apiKey?: string;
  /** Whether to drive an OAuth login when no credential is configured. */
  useOAuth: boolean;
  /** Copilot CLI OAuth refresh token, seeded before probing (github-copilot only). */
  copilotRefreshToken?: string;
  /** Optional HTTP model proxy endpoint that replaces the provider's base URL. */
  httpProxyUrl?: string;
  /** Provider whose built-in model catalog is routed through the proxy. */
  proxiedProviderId?: string;
  /** Caller-supplied pi-ai provider registered verbatim (custom/local providers). */
  customProvider?: Provider;
}

/** Authenticated model resolution: the provider's `Models` collection plus the
 *  resolved `Model`, ready to construct an `AgentHarness`. */
export interface ResolvedModel {
  models: Models;
  model: Model<Api>;
}

export class ModelProvider {
  private readonly models: MutableModels;
  private readonly credentials: CredentialStore;
  private readonly callbacks: AuthLoginCallbacks;
  private authOnce?: Promise<void>;

  private constructor(private readonly config: ResolvedConfig) {
    this.credentials = config.credentials ?? new InMemoryCredentialStore();
    this.callbacks = config.callbacks ?? defaultLoginCallbacks();
    this.models = builtinModels({
      credentials: config.httpProxyUrl
        ? withoutCredentialForProvider(this.credentials, config.providerId)
        : this.credentials,
      authContext: config.authContext ?? nodeAuthContext(),
    });
    if (config.httpProxyUrl) {
      const proxiedProviderId = config.proxiedProviderId ?? config.providerId;
      const provider = this.models.getProvider(proxiedProviderId);
      if (!provider) throw new Error(`Unknown provider: ${proxiedProviderId}`);
      this.models.setProvider(withHttpProxyUrl(provider, config.providerId, config.httpProxyUrl));
    }
    if (config.customProvider) {
      this.models.setProvider(config.customProvider);
    }
  }

  /**
   * API-key auth. `apiKey` is optional — when omitted, the provider's ambient
   * environment variable (e.g. ANTHROPIC_API_KEY) is used if present.
   */
  static apiKey(
    opts: ModelProviderShared & { apiKey?: ApiKey; provider?: string } = {},
  ): ModelProvider {
    return new ModelProvider({
      ...opts,
      providerId: opts.provider ?? "anthropic",
      apiKey: opts.apiKey,
      useOAuth: false,
    });
  }

  /**
   * Custom/local provider auth. Registers a caller-supplied pi-ai `Provider`
   * verbatim and resolves auth through that provider's own auth semantics — no
   * OAuth, no api-key seeding. Use for local, ambient, or test providers (e.g.
   * pi-ai's `fauxProvider`) that carry their own keyless or self-contained auth.
   */
  static custom(opts: ModelProviderShared & { provider: Provider }): ModelProvider {
    return new ModelProvider({
      ...opts,
      providerId: opts.provider.id,
      useOAuth: false,
      customProvider: opts.provider,
    });
  }

  /**
   * GitHub Copilot subscription auth. First tries to reuse a token already
   * minted by the Copilot CLI (`apps.json`); only when none is found does it
   * fall back to GitHub's OAuth device flow (browser + device code). Pass
   * `{ cliCredentials: false }` to force the device flow.
   */
  static githubCopilot(opts: ModelProviderShared & { cliCredentials?: boolean } = {}): ModelProvider {
    const copilotRefreshToken =
      opts.cliCredentials === false ? undefined : discoverCopilotCliToken();
    return new ModelProvider({
      ...opts,
      providerId: "github-copilot",
      useOAuth: true,
      copilotRefreshToken,
    });
  }

  /**
   * Provider routed through an HTTP model proxy. This mirrors pi-agent's
   * provider `baseUrl` override for built-in models, but treats the proxy as
   * the auth boundary: callers do not provide provider API keys.
   */
  static httpProxy(
    opts: ModelProviderShared & {
      httpProxyUrl: HttpProxyUrl;
      provider?: string;
    },
  ): ModelProvider {
    const providerId = opts.provider ?? "anthropic";
    return new ModelProvider({
      ...opts,
      providerId,
      proxiedProviderId: providerId,
      useOAuth: false,
      httpProxyUrl: normalizeHttpProxyUrl(opts.httpProxyUrl),
    });
  }

  /** Resolve `model` against this provider, authenticating (once) if needed,
   *  and return the authenticated `Models` collection plus resolved `Model` for
   *  harness construction. Auth is lazy and memoized via `authenticate`. */
  async resolveModel(model: ModelId): Promise<ResolvedModel> {
    await this.authenticate(model);

    const resolved = this.models.getModel(this.config.providerId, model);
    if (!resolved) {
      throw new Error(`Model not found: ${this.config.providerId}/${model}`);
    }

    return { models: this.models, model: resolved };
  }

  /** Ensure the provider is authenticated. Memoized: concurrent callers share
   *  one login. `model` is the model the first caller intends to use. */
  authenticate(model: ModelId): Promise<void> {
    return (this.authOnce ??= this.runAuth(model));
  }

  private async runAuth(model: ModelId): Promise<void> {
    const { providerId } = this.config;
    const provider = this.models.getProvider(providerId);
    if (!provider) throw new Error(`Unknown provider: ${providerId}`);

    // Seed an explicit api key, if one was supplied.
    if (!this.config.useOAuth && this.config.apiKey) {
      const key = this.config.apiKey;
      await this.credentials.modify(providerId, async () => ({ type: "api_key", key }));
    }

    // Seed a discovered Copilot CLI OAuth token so the probe below refreshes it
    // into a live credential — no device flow. A stored credential wins.
    if (this.config.useOAuth && this.config.copilotRefreshToken) {
      const refresh = this.config.copilotRefreshToken;
      await this.credentials.modify(
        providerId,
        async (current) => current ?? { type: "oauth", refresh, access: "", expires: 0 },
      );
    }

    // Already configured? (stored credential or ambient env)
    const probe = this.models.getModel(providerId, model);
    if (probe && (await this.models.getAuth(probe))) return;

    // Not configured — drive a login flow.
    if (this.config.useOAuth) {
      if (!provider.auth.oauth) {
        throw new Error(`Provider ${providerId} does not support OAuth`);
      }
      this.callbacks.notify({ type: "progress", message: `Authenticating with ${provider.name}...` });
      const credential = await provider.auth.oauth.login(this.callbacks);
      await this.credentials.modify(providerId, async () => credential);
      // Copilot is a dynamic provider: its catalog populates after login.
      await this.models.refresh(providerId);
    } else {
      throw new Error(
        `No API key for ${providerId}. Pass apiKey or set the provider's env var.`,
      );
    }

    // Verify.
    const resolved = this.models.getModel(providerId, model);
    if (!resolved || !(await this.models.getAuth(resolved))) {
      throw new Error(`Authentication failed for ${providerId}`);
    }
  }
}

function withHttpProxyUrl(provider: Provider, providerId: string, httpProxyUrl: string): Provider {
  const refreshModels = provider.refreshModels?.bind(provider);
  const withProxyUrl = <T extends Api>(model: Model<T>): Model<T> => ({
    ...model,
    provider: providerId,
    baseUrl: httpProxyUrl,
  });

  return {
    id: providerId,
    name: `${provider.name} HTTP Proxy`,
    baseUrl: httpProxyUrl,
    headers: provider.headers,
    auth: {
      apiKey: {
        name: `${provider.name} HTTP Proxy`,
        resolve: async () => ({ auth: { apiKey: "unused" }, source: "HTTP proxy" }),
      },
    },
    getModels: () => provider.getModels().map(withProxyUrl),
    ...(refreshModels ? { refreshModels } : {}),
    stream: (model, context, options) => provider.stream(withProxyUrl(model), context, options),
    streamSimple: (model, context, options) =>
      provider.streamSimple(withProxyUrl(model), context, options),
  };
}

function withoutCredentialForProvider(
  credentials: CredentialStore,
  providerId: string,
): CredentialStore {
  return {
    read: async (id) => (id === providerId ? undefined : credentials.read(id)),
    modify: (id, fn) => credentials.modify(id, fn),
    delete: (id) => credentials.delete(id),
  };
}

function normalizeHttpProxyUrl(httpProxyUrl: string): string {
  const trimmed = httpProxyUrl.trim().replace(/\/+$/, "");
  if (!trimmed) throw new Error("HTTP proxy URL must not be empty");

  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`Invalid HTTP proxy URL: ${httpProxyUrl}`);
  }

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(`HTTP proxy URL must use http or https: ${httpProxyUrl}`);
  }

  return trimmed;
}

// --- default login UX: console messages + open the browser -----------------

function defaultLoginCallbacks(): AuthLoginCallbacks {
  return {
    notify(event) {
      switch (event.type) {
        case "auth_url":
          console.log(`\nOpen this URL to authenticate:\n  ${event.url}`);
          if (event.instructions) console.log(event.instructions);
          openBrowser(event.url);
          break;
        case "device_code":
          console.log(
            `\nTo authenticate, open:\n  ${event.verificationUri}\n` +
              `and enter the code:\n  ${event.userCode}\n`,
          );
          openBrowser(event.verificationUri);
          break;
        case "progress":
          console.log(event.message);
          break;
      }
    },
    async prompt(p) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      try {
        if (p.type === "select") {
          console.log(p.message);
          p.options.forEach((o, i) =>
            console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`),
          );
          const answer = await rl.question("Select a number: ");
          return p.options[Number(answer) - 1]?.id ?? p.options[0].id;
        }
        return (await rl.question(`${p.message} `)).trim();
      } finally {
        rl.close();
      }
    },
  };
}

function openBrowser(url: string): void {
  const [cmd, args] =
    process.platform === "darwin"
      ? ["open", [url]]
      : process.platform === "win32"
        ? ["cmd", ["/c", "start", "", url]]
        : ["xdg-open", [url]];
  try {
    spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
  } catch {
    /* best effort — the URL is also printed */
  }
}

function nodeAuthContext(): AuthContext {
  return {
    env: async (name) => process.env[name],
    fileExists: async (path) =>
      existsSync(path.startsWith("~") ? path.replace("~", homedir()) : path),
  };
}

// Re-export for callers that want the model type without importing pi-ai.
export type { Model, Api, Models };
