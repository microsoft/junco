# model-auth

Authentication and model resolution for pi agents.

`ModelProvider` owns auth and model resolution only. Repository tools are supplied by the consumer so this package stays independent from any specific repo/tool package.

## Install

This workspace exposes the package as `model-auth`:

```json
{
  "dependencies": {
    "model-auth": "workspace:*"
  }
}
```

## Usage

```ts
import { ApiKey, ModelId, ModelProvider } from "model-auth";

const provider = ModelProvider.apiKey({
  apiKey: process.env.ANTHROPIC_API_KEY
    ? ApiKey(process.env.ANTHROPIC_API_KEY)
    : undefined,
});

const { models, model } = await provider.resolveModel(ModelId("claude-sonnet-4-6"));
// Pass `models` + `model` to an AgentHarness (see junco-agent) to run prompts.
```

## Auth modes

### API key

```ts
ModelProvider.apiKey({ apiKey: ApiKey("sk-...") });
```

If `apiKey` is omitted, the provider's ambient environment variable is used, such as `ANTHROPIC_API_KEY` for Anthropic.

### GitHub Copilot

```ts
ModelProvider.githubCopilot();
```

`githubCopilot()` first tries to reuse a credential already minted by the GitHub Copilot CLI (its `apps.json`), refreshing it into a live token with no interaction. Only when none is found does it fall back to GitHub's OAuth device flow, which prints the verification URL/code and opens the browser when possible. Pass `githubCopilot({ cliCredentials: false })` to skip the CLI credential and force the device flow.

### HTTP proxy

```ts
ModelProvider.httpProxy({
  httpProxyUrl: HttpProxyUrl("https://my-proxy.example.com/v1"),
});
```

This mirrors pi-agent's built-in-provider proxy support: the provider's model catalog is preserved, while the provider endpoint is replaced by the proxy URL. The proxy is treated as the auth boundary, so callers do not provide provider API keys.

### Custom / local provider

```ts
import { fauxProvider } from "@earendil-works/pi-ai";

const faux = fauxProvider();
ModelProvider.custom({ provider: faux.provider });
```

`ModelProvider.custom({ provider })` registers a caller-supplied pi-ai `Provider` verbatim and resolves auth through that provider's own semantics — no OAuth, no api-key seeding. Use it for local, ambient, or test providers (e.g. pi-ai's in-memory `fauxProvider`) that carry keyless or self-contained auth. The provider's `id` becomes the provider id used for model resolution.

## Model resolution

`resolveModel(model)` authenticates the provider lazily and exactly once (memoized), then resolves `model` against the provider's catalog:

- On success it returns `{ models, model }` — the authenticated `Models` collection plus the resolved `Model` — ready to hand to an `AgentHarness`.
- If `model` is unknown for this provider it throws `Model not found: <provider>/<model>`.

Auth is lazy and memoized: resolving several models from one provider shares a single login path. Harness construction (`cwd`/`tools`/`thinkingLevel`) now lives in the consumer package (`junco-agent`).
