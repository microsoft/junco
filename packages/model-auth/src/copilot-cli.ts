// copilot-cli.ts
// ---------------------------------------------------------------------------
// Discover a GitHub Copilot OAuth token already minted by the Copilot CLI.
//
// The CLI persists its logged-in credential to `github-copilot/apps.json` under
// its config directory, keyed by `github.com:<githubAppId>`. pi-ai's Copilot
// provider uses the SAME public GitHub OAuth App id, so the CLI's stored
// `oauth_token` is a valid pi-ai OAuth *refresh* token — seeding it lets
// resolveModel refresh into a live Copilot token with no interactive login.
// ---------------------------------------------------------------------------
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** Public GitHub OAuth App id shared by the Copilot CLI and pi-ai's provider. */
const COPILOT_GITHUB_APP_ID = "Iv1.b507a08c87ecfe98";

interface AppsEntry {
  oauth_token?: string;
  githubAppId?: string;
}

/**
 * Return the Copilot CLI's stored OAuth token, or `undefined` if none is found.
 * Any missing file, parse error, or absent token resolves to `undefined` — the
 * caller falls back to the interactive device flow.
 */
export function discoverCopilotCliToken(): string | undefined {
  try {
    const candidates: string[] = [];
    const xdg = process.env["XDG_CONFIG_HOME"];
    if (xdg) candidates.push(join(xdg, "github-copilot", "apps.json"));
    const localAppData = process.env["LOCALAPPDATA"];
    if (localAppData) candidates.push(join(localAppData, "github-copilot", "apps.json"));
    candidates.push(join(homedir(), ".config", "github-copilot", "apps.json"));

    const path = candidates.find((candidate) => existsSync(candidate));
    if (!path) return undefined;

    const parsed = JSON.parse(readFileSync(path, "utf8")) as Record<string, AppsEntry>;
    const entries = Object.entries(parsed);

    const preferred = entries.find(
      ([key, value]) => value.githubAppId === COPILOT_GITHUB_APP_ID || key.endsWith(COPILOT_GITHUB_APP_ID),
    );
    if (preferred?.[1].oauth_token) return preferred[1].oauth_token;

    const anyWithToken = entries.find(([, value]) => !!value.oauth_token);
    return anyWithToken?.[1].oauth_token;
  } catch {
    return undefined;
  }
}
