// Caches `overcast commands --json` in globalState keyed by the CLI version,
// so the Run Verb quick-pick opens instantly and refreshes when the CLI is
// upgraded.
//
// Verified output shapes (v0.0.9): `--version --json` prints a BARE object
// {"overcast":"0.0.9","pi":"…","node":"…"} and `commands --json` prints a BARE
// {verbs:[VerbSpecJSON…]} — neither is a record envelope, but parseRecords
// (lib/cliOutput.ts) still yields each as one parsed object.
import * as vscode from "vscode";
import type { VerbSpecJSON } from "../types.ts";
import type { CliBridge } from "./cliBridge.ts";

interface CachedRegistry {
  version: string;
  verbs: VerbSpecJSON[];
}

const CACHE_KEY = "overcast.verbRegistry";

export class VerbRegistry {
  private memory: CachedRegistry | undefined;

  constructor(
    private readonly bridge: CliBridge,
    private readonly context: vscode.ExtensionContext,
  ) {}

  private async cliVersion(): Promise<string | undefined> {
    const res = await this.bridge.run(["--version"], { noCaseFlag: true });
    const doc = res.records[0] as unknown as { overcast?: unknown } | undefined;
    return typeof doc?.overcast === "string" ? doc.overcast : undefined;
  }

  /** Cached registry (memory → globalState keyed by CLI version → fetch). */
  async getVerbs(): Promise<VerbSpecJSON[]> {
    if (this.memory) return this.memory.verbs;
    const version = await this.cliVersion();
    const cached = this.context.globalState.get<CachedRegistry>(CACHE_KEY);
    if (cached && version && cached.version === version && cached.verbs?.length) {
      this.memory = cached;
      return cached.verbs;
    }
    return this.fetch(version);
  }

  /** Force refetch (e.g. after the CLI is upgraded mid-session). */
  async refresh(): Promise<VerbSpecJSON[]> {
    return this.fetch(await this.cliVersion());
  }

  private async fetch(version: string | undefined): Promise<VerbSpecJSON[]> {
    const res = await this.bridge.run(["commands"], { noCaseFlag: true });
    if (res.failure) return this.memory?.verbs ?? [];
    const doc = res.records[0] as unknown as { verbs?: VerbSpecJSON[] } | undefined;
    const verbs = Array.isArray(doc?.verbs) ? doc.verbs : [];
    if (verbs.length > 0) {
      this.memory = { version: version ?? "unknown", verbs };
      await this.context.globalState.update(CACHE_KEY, this.memory);
    }
    return verbs;
  }
}
